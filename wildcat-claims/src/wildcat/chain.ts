import { Contract, JsonRpcProvider, type BlockTag } from 'ethers';
import { WildcatConfig } from './config';
import { ARCH_CONTROLLER_ABI, MARKET_ABI, ERC20_ABI, LENS_ABI } from './abis';

/** Market state relevant to attribution + delinquency reporting (metadata only). */
export interface MarketSnapshot {
  market: string;
  borrower: string;
  asset: string;
  assetSymbol: string;
  assetDecimals: number;
  isClosed: boolean;
  isDelinquent: boolean;
  timeDelinquent: bigint;
  delinquencyGracePeriod: bigint;
  /** True if the penalty APR is active (rolling grace period exceeded). */
  penaltyActive: boolean;
}

/** Everything needed to evaluate one lender against one market at the pinned block. */
export interface MarketLenderData {
  snapshot: MarketSnapshot;
  /** Held market-token position (balanceOf / lens normalizedBalance), underlying wei. */
  heldWei: bigint;
  /** Lender's share of queued/expired withdrawal batches, underlying wei (0 if disabled). */
  withdrawalsWei: bigint;
  /** True if the withdrawal read failed and the figure may be incomplete. */
  withdrawalsError: boolean;
}

const MARKETS_PAGE = 100n;
const RAY = 10n ** 27n;

export class Chain {
  readonly provider: JsonRpcProvider;
  readonly arch: Contract;
  readonly lens: Contract;
  private readonly cfg: WildcatConfig;
  private resolvedBlock?: number;
  private lensWarned = false;

  constructor(cfg: WildcatConfig) {
    this.cfg = cfg;
    this.provider = new JsonRpcProvider(cfg.rpcUrl);
    this.arch = new Contract(cfg.addresses.archController, ARCH_CONTROLLER_ABI, this.provider);
    this.lens = new Contract(cfg.addresses.marketLens, LENS_ABI, this.provider);
  }

  market(address: string): Contract {
    return new Contract(address, MARKET_ABI, this.provider);
  }

  /**
   * The block all reads are pinned to: explicit snapshotBlock, else the block at/just
   * before the eligibility timestamp, else 'latest'. Resolved once and memoised.
   */
  async resolveEligibilityBlock(): Promise<number> {
    if (this.resolvedBlock !== undefined) return this.resolvedBlock;
    if (this.cfg.snapshotBlock !== undefined) {
      this.resolvedBlock = this.cfg.snapshotBlock;
    } else if (this.cfg.eligibilityTimestamp !== undefined) {
      this.resolvedBlock = await this.blockForTimestamp(this.cfg.eligibilityTimestamp);
    } else {
      this.resolvedBlock = await this.provider.getBlockNumber();
    }
    return this.resolvedBlock;
  }

  private async blockTag(): Promise<BlockTag> {
    return this.resolveEligibilityBlock();
  }

  /** Highest block whose timestamp is <= target (binary search). */
  private async blockForTimestamp(targetSec: number): Promise<number> {
    let lo = 1;
    let hi = await this.provider.getBlockNumber();
    const latest = await this.provider.getBlock(hi);
    if (latest && Number(latest.timestamp) <= targetSec) return hi;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const block = await this.provider.getBlock(mid);
      if (block && Number(block.timestamp) <= targetSec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Enumerate every market registered on the arch-controller (paginated). */
  async getAllMarkets(): Promise<string[]> {
    const tag = await this.blockTag();
    const count: bigint = await this.arch.getRegisteredMarketsCount({ blockTag: tag });
    const markets: string[] = [];
    for (let i = 0n; i < count; i += MARKETS_PAGE) {
      const page: string[] = await this.arch.getRegisteredMarkets(i, i + MARKETS_PAGE, {
        blockTag: tag,
      });
      markets.push(...page);
    }
    return markets;
  }

  /**
   * Read market metadata + the lender's held position, via the lens when configured,
   * and fold in withdrawal-batch amounts. Lens decode failures auto-fall-back to the
   * verified direct path (warned once).
   */
  async readEligibilityData(market: string, lender: string): Promise<MarketLenderData> {
    const tag = await this.blockTag();

    let base: { snapshot: MarketSnapshot; heldWei: bigint };
    if (this.cfg.lensMode === 'lens') {
      try {
        base = await this.readViaLens(market, lender, tag);
      } catch (err: any) {
        if (!this.lensWarned) {
          console.warn(
            `MarketLens read failed (${err.message}); falling back to direct reads. ` +
              'Verify LENS_ABI against the deployed MarketLens artifact to enable the lens path.'
          );
          this.lensWarned = true;
        }
        base = await this.readDirect(market, lender, tag);
      }
    } else {
      base = await this.readDirect(market, lender, tag);
    }

    let withdrawalsWei = 0n;
    let withdrawalsError = false;
    if (this.cfg.includeWithdrawals) {
      try {
        withdrawalsWei = await this.readWithdrawalsOwed(market, lender, tag);
      } catch (err: any) {
        withdrawalsError = true;
        console.error(`Withdrawal read failed for ${market}/${lender}: ${err.message}`);
      }
    }

    return { ...base, withdrawalsWei, withdrawalsError };
  }

  /** Combined market + lender read via MarketLens.getMarketDataWithLenderStatus. */
  private async readViaLens(
    market: string,
    lender: string,
    tag: BlockTag
  ): Promise<{ snapshot: MarketSnapshot; heldWei: bigint }> {
    const res = await this.lens.getMarketDataWithLenderStatus(lender, market, { blockTag: tag });
    const md = res.marketData ?? res[0];
    const ls = res.lenderStatus ?? res[1];
    const timeDelinquent = BigInt(md.timeDelinquent);
    const grace = BigInt(md.delinquencyGracePeriod);
    const snapshot: MarketSnapshot = {
      market,
      borrower: md.borrower,
      asset: md.asset,
      assetSymbol: md.assetSymbol,
      assetDecimals: Number(md.assetDecimals),
      isClosed: md.isClosed,
      isDelinquent: md.isDelinquent,
      timeDelinquent,
      delinquencyGracePeriod: grace,
      penaltyActive: timeDelinquent > grace,
    };
    return { snapshot, heldWei: BigInt(ls.normalizedBalance) };
  }

  /** Verified per-market path: currentState() + immutables + balanceOf + ERC20 metadata. */
  private async readDirect(
    market: string,
    lender: string,
    tag: BlockTag
  ): Promise<{ snapshot: MarketSnapshot; heldWei: bigint }> {
    const m = this.market(market);
    const opt = { blockTag: tag };
    const [state, borrower, asset, grace, heldWei] = await Promise.all([
      m.currentState(opt),
      m.borrower(opt),
      m.asset(opt),
      m.delinquencyGracePeriod(opt),
      m.balanceOf(lender, opt) as Promise<bigint>,
    ]);
    const token = new Contract(asset, ERC20_ABI, this.provider);
    const [symbol, decimals] = await Promise.all([token.symbol(opt), token.decimals(opt)]);

    const timeDelinquent = BigInt(state.timeDelinquent);
    const delinquencyGracePeriod = BigInt(grace);
    const snapshot: MarketSnapshot = {
      market,
      borrower,
      asset,
      assetSymbol: symbol,
      assetDecimals: Number(decimals),
      isClosed: state.isClosed,
      isDelinquent: state.isDelinquent,
      timeDelinquent,
      delinquencyGracePeriod,
      penaltyActive: timeDelinquent > delinquencyGracePeriod,
    };
    return { snapshot, heldWei: BigInt(heldWei) };
  }

  /**
   * Lender's still-owed share of queued/expired withdrawal batches, in underlying wei.
   * Best-effort: normalizes the lender's remaining scaled amount at the live scaleFactor
   * and subtracts what they've already withdrawn. Verify against protocol redemption math
   * for fully-paid expired batches before relying on it for legal figures.
   */
  private async readWithdrawalsOwed(market: string, lender: string, tag: BlockTag): Promise<bigint> {
    const m = this.market(market);
    const opt = { blockTag: tag };
    const [state, unpaid] = await Promise.all([
      m.currentState(opt),
      m.getUnpaidBatchExpiries(opt) as Promise<bigint[]>,
    ]);
    const scaleFactor = BigInt(state.scaleFactor);
    const pending = BigInt(state.pendingWithdrawalExpiry);

    const expiries = new Set<bigint>(unpaid.map((e) => BigInt(e)));
    if (pending > 0n) expiries.add(pending);
    if (expiries.size === 0) return 0n;

    let total = 0n;
    for (const expiry of expiries) {
      const status = await m.getAccountWithdrawalStatus(lender, expiry, opt);
      const scaled = BigInt(status.scaledAmount);
      if (scaled === 0n) continue;
      const normalized = (scaled * scaleFactor) / RAY;
      const remaining = normalized - BigInt(status.normalizedAmountWithdrawn);
      if (remaining > 0n) total += remaining;
    }
    return total;
  }
}

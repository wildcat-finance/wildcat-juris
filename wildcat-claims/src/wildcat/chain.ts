import { Contract, JsonRpcProvider, type BlockTag } from 'ethers';
import { WildcatConfig } from './config';
import { ARCH_CONTROLLER_ABI, MARKET_ABI, ERC20_ABI, LENS_ABI } from './abis';

/** Immutable market identity (cached). */
export interface MarketInfo {
  market: string;
  borrower: string;
  name: string;
  asset: string;
  assetSymbol: string;
  assetDecimals: number;
}

/** Live market state relevant to the default gate. */
export interface MarketState {
  isClosed: boolean;
  isDelinquent: boolean;
  timeDelinquent: bigint;
  delinquencyGracePeriod: bigint;
}

const MARKETS_PAGE = 100n;
const RAY = 10n ** 27n;

export class Chain {
  readonly provider: JsonRpcProvider;
  readonly arch: Contract;
  readonly lens: Contract;
  private readonly cfg: WildcatConfig;
  private readonly infoCache = new Map<string, MarketInfo>();
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

  private blockTag(): BlockTag {
    return this.cfg.snapshotBlock ?? 'latest';
  }

  /** Block the reads resolve to, recorded in each claim for audit. */
  async resolveAsOfBlock(): Promise<number> {
    return this.cfg.snapshotBlock ?? this.provider.getBlockNumber();
  }

  /** Enumerate every market registered on the arch-controller (paginated). */
  async getAllMarkets(): Promise<string[]> {
    const tag = this.blockTag();
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

  /** Immutable market identity (borrower, name, asset, token metadata). Cached. */
  async getMarketInfo(market: string): Promise<MarketInfo> {
    const key = market.toLowerCase();
    const cached = this.infoCache.get(key);
    if (cached) return cached;

    const m = this.market(market);
    const tag = { blockTag: this.blockTag() };
    const [borrower, name, asset] = await Promise.all([m.borrower(tag), m.name(tag), m.asset(tag)]);
    const token = new Contract(asset, ERC20_ABI, this.provider);
    const [symbol, decimals] = await Promise.all([token.symbol(tag), token.decimals(tag)]);

    const info: MarketInfo = {
      market,
      borrower,
      name,
      asset,
      assetSymbol: symbol,
      assetDecimals: Number(decimals),
    };
    this.infoCache.set(key, info);
    return info;
  }

  /** Live delinquency state (verified currentState path). */
  async getMarketState(market: string): Promise<MarketState> {
    const m = this.market(market);
    const tag = { blockTag: this.blockTag() };
    const [state, grace] = await Promise.all([m.currentState(tag), m.delinquencyGracePeriod(tag)]);
    return {
      isClosed: state.isClosed,
      isDelinquent: state.isDelinquent,
      timeDelinquent: BigInt(state.timeDelinquent),
      delinquencyGracePeriod: BigInt(grace),
    };
  }

  /** Markets whose immutable borrower matches `borrower`. */
  async getMarketsForBorrower(borrower: string): Promise<MarketInfo[]> {
    const all = await this.getAllMarkets();
    const target = borrower.toLowerCase();
    const infos = await Promise.all(all.map((m) => this.getMarketInfo(m)));
    return infos.filter((i) => i.borrower.toLowerCase() === target);
  }

  /**
   * A lender's held market-token position (underlying wei). Uses the lens when
   * configured; a decode failure auto-falls-back to the verified balanceOf path.
   */
  async readLenderHeld(market: string, lender: string): Promise<bigint> {
    const tag = this.blockTag();
    if (this.cfg.lensMode === 'lens') {
      try {
        const res = await this.lens.getMarketDataWithLenderStatus(lender, market, { blockTag: tag });
        const ls = res.lenderStatus ?? res[1];
        return BigInt(ls.normalizedBalance);
      } catch (err: any) {
        if (!this.lensWarned) {
          console.warn(
            `MarketLens read failed (${err.message}); falling back to balanceOf. ` +
              'Verify LENS_ABI against the deployed MarketLens artifact to enable the lens path.'
          );
          this.lensWarned = true;
        }
      }
    }
    const m = this.market(market);
    return BigInt(await m.balanceOf(lender, { blockTag: tag }));
  }

  /**
   * Lender's still-owed share of queued/expired withdrawal batches, in underlying wei.
   * Best-effort: normalizes the lender's remaining scaled amount at the live scaleFactor
   * and subtracts what they've already withdrawn. Verify against protocol redemption math
   * for fully-paid expired batches before relying on it for legal figures.
   */
  async readWithdrawalsOwed(market: string, lender: string): Promise<bigint> {
    const m = this.market(market);
    const opt = { blockTag: this.blockTag() };
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

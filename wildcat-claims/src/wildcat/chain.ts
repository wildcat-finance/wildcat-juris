import { Contract, JsonRpcProvider, Network, type BlockTag } from 'ethers';
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

export class Chain {
  readonly provider: JsonRpcProvider;
  readonly arch: Contract;
  readonly lens: Contract;
  private readonly cfg: WildcatConfig;
  private readonly infoCache = new Map<string, MarketInfo>();
  private lensWarned = false;

  constructor(cfg: WildcatConfig) {
    this.cfg = cfg;
    // Pin to a static network: the chain id is known, so skip auto-detection (which
    // otherwise retries forever if the RPC misbehaves) and fail fast on a bad endpoint.
    const network = Network.from(cfg.chainId);
    this.provider = new JsonRpcProvider(cfg.rpcUrl, network, { staticNetwork: network });
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

  /**
   * Every market registered on the arch-controller. Uses the no-arg
   * getRegisteredMarkets() (one call, selector 0x46762101); falls back to the
   * paginated overload only if that reverts (e.g. a future registry too large).
   */
  async getAllMarkets(): Promise<string[]> {
    const tag = this.blockTag();
    try {
      return await this.arch['getRegisteredMarkets()']({ blockTag: tag });
    } catch {
      const count: bigint = await this.arch.getRegisteredMarketsCount({ blockTag: tag });
      const markets: string[] = [];
      for (let i = 0n; i < count; i += MARKETS_PAGE) {
        const page: string[] = await this.arch['getRegisteredMarkets(uint256,uint256)'](
          i,
          i + MARKETS_PAGE,
          { blockTag: tag }
        );
        markets.push(...page);
      }
      return markets;
    }
  }

  /** A market's immutable borrower (one call) — used to filter the registry. */
  async readBorrower(market: string): Promise<string> {
    return this.market(market).borrower({ blockTag: this.blockTag() });
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

  /**
   * A lender's held market-token position (underlying wei) via
   * MarketLensV2.getLenderAccountData; a decode/call failure auto-falls-back to the
   * market's balanceOf. With LENS_MODE=direct, balanceOf is used directly.
   */
  async readLenderHeld(market: string, lender: string): Promise<bigint> {
    const tag = this.blockTag();
    if (this.cfg.lensMode === 'lens') {
      try {
        const data = await this.lens.getLenderAccountData(lender, market, { blockTag: tag });
        return BigInt(data.normalizedBalance);
      } catch (err: any) {
        if (!this.lensWarned) {
          console.warn(`MarketLensV2.getLenderAccountData failed (${err.message}); falling back to balanceOf.`);
          this.lensWarned = true;
        }
      }
    }
    const m = this.market(market);
    return BigInt(await m.balanceOf(lender, { blockTag: tag }));
  }

  /**
   * Lender's still-owed share of queued/expired withdrawal batches, in underlying wei.
   * Authoritative: sums MarketLensV2 WithdrawalBatchLenderStatus.normalizedAmountOwed
   * across the market's unpaid batches.
   */
  async readWithdrawalsOwed(market: string, lender: string): Promise<bigint> {
    const tag = this.blockTag();
    const expiries: bigint[] = await this.market(market).getUnpaidBatchExpiries({ blockTag: tag });
    if (expiries.length === 0) return 0n;
    const statuses = await this.lens.getWithdrawalBatchesDataWithLenderStatus(market, expiries, lender, {
      blockTag: tag,
    });
    let total = 0n;
    for (const s of statuses) {
      total += BigInt((s.lenderStatus ?? s[1]).normalizedAmountOwed);
    }
    return total;
  }
}

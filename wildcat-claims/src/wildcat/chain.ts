import { Contract, Interface, JsonRpcProvider, Network, type BlockTag } from 'ethers';
import { WildcatConfig } from './config';
import { ARCH_CONTROLLER_ABI, MARKET_ABI, ERC20_ABI, LENS_ABI, MULTICALL3_ABI } from './abis';

interface Call3 {
  target: string;
  callData: string;
}
interface Result3 {
  success: boolean;
  returnData: string;
}

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
  readonly multicall: Contract;
  private readonly cfg: WildcatConfig;
  private readonly marketIface = new Interface(MARKET_ABI);
  private readonly erc20Iface = new Interface(ERC20_ABI);
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
    this.multicall = new Contract(cfg.addresses.multicall3, MULTICALL3_ABI, this.provider);
  }

  market(address: string): Contract {
    return new Contract(address, MARKET_ABI, this.provider);
  }

  private blockTag(): BlockTag {
    return this.cfg.snapshotBlock ?? 'latest';
  }

  /** Batch many read calls into a single eth_call via Multicall3.aggregate3. */
  private async aggregate3(calls: Call3[]): Promise<Result3[]> {
    if (calls.length === 0) return [];
    const reqs = calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }));
    const res = await this.multicall.aggregate3(reqs, { blockTag: this.blockTag() });
    return res.map((r: any) => ({ success: r.success ?? r[0], returnData: r.returnData ?? r[1] }));
  }

  /** Block the reads resolve to, recorded in each claim for audit. */
  async resolveAsOfBlock(): Promise<number> {
    return this.cfg.snapshotBlock ?? this.provider.getBlockNumber();
  }

  /** True if the address has contract code (i.e. a smart-contract wallet such as a Safe). */
  async isContract(address: string): Promise<boolean> {
    return (await this.provider.getCode(address)) !== '0x';
  }

  /**
   * EIP-1271: ask a smart-contract wallet whether `signature` authorizes `digest`. A Safe
   * returns the magic value 0x1626ba7e once its owner threshold has signed. This is how
   * Safe (and other contract wallets) "sign" — they have no ECDSA key to recover.
   */
  async isValidErc1271(signer: string, digest: string, signature: string): Promise<boolean> {
    const wallet = new Contract(
      signer,
      ['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'],
      this.provider
    );
    try {
      const magic: string = await wallet.isValidSignature(digest, signature);
      return typeof magic === 'string' && magic.toLowerCase() === '0x1626ba7e';
    } catch {
      return false;
    }
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

  /** Every market's immutable borrower, in ONE eth_call via Multicall3 (for the registry filter). */
  async readBorrowers(markets: string[]): Promise<(string | null)[]> {
    const callData = this.marketIface.encodeFunctionData('borrower');
    const results = await this.aggregate3(markets.map((target) => ({ target, callData })));
    return results.map((r) =>
      r.success ? (this.marketIface.decodeFunctionResult('borrower', r.returnData)[0] as string) : null
    );
  }

  /**
   * Market identity + live state for a set of markets, batched via Multicall3: one eth_call
   * for {currentState, borrower, name, asset, delinquencyGracePeriod} across all markets, then
   * one for {symbol, decimals} across the unique underlying assets.
   */
  async readMarketsInfoAndState(
    markets: string[]
  ): Promise<{ info: MarketInfo; state: MarketState }[]> {
    if (markets.length === 0) return [];
    const fns = ['currentState', 'borrower', 'name', 'asset', 'delinquencyGracePeriod'] as const;

    const calls: Call3[] = [];
    for (const target of markets) {
      for (const fn of fns) calls.push({ target, callData: this.marketIface.encodeFunctionData(fn) });
    }
    const res = await this.aggregate3(calls);

    const dec = (fn: string, r: Result3) => this.marketIface.decodeFunctionResult(fn, r.returnData);
    const rows = markets.map((market, i) => {
      const b = i * fns.length;
      const state = dec('currentState', res[b])[0];
      return {
        market,
        borrower: dec('borrower', res[b + 1])[0] as string,
        name: dec('name', res[b + 2])[0] as string,
        asset: dec('asset', res[b + 3])[0] as string,
        grace: BigInt(dec('delinquencyGracePeriod', res[b + 4])[0]),
        state,
      };
    });

    // Token metadata for the unique assets (one more batched call).
    const assets = [...new Set(rows.map((r) => r.asset.toLowerCase()))];
    const metaCalls: Call3[] = [];
    for (const a of assets) {
      metaCalls.push({ target: a, callData: this.erc20Iface.encodeFunctionData('symbol') });
      metaCalls.push({ target: a, callData: this.erc20Iface.encodeFunctionData('decimals') });
    }
    const metaRes = await this.aggregate3(metaCalls);
    const meta = new Map<string, { symbol: string; decimals: number }>();
    assets.forEach((a, i) => {
      const symbol = this.erc20Iface.decodeFunctionResult('symbol', metaRes[i * 2].returnData)[0] as string;
      const decimals = Number(this.erc20Iface.decodeFunctionResult('decimals', metaRes[i * 2 + 1].returnData)[0]);
      meta.set(a, { symbol, decimals });
    });

    return rows.map((r) => {
      const tm = meta.get(r.asset.toLowerCase())!;
      const info: MarketInfo = {
        market: r.market,
        borrower: r.borrower,
        name: r.name,
        asset: r.asset,
        assetSymbol: tm.symbol,
        assetDecimals: tm.decimals,
      };
      const state: MarketState = {
        isClosed: r.state.isClosed,
        isDelinquent: r.state.isDelinquent,
        timeDelinquent: BigInt(r.state.timeDelinquent),
        delinquencyGracePeriod: r.grace,
      };
      this.infoCache.set(r.market.toLowerCase(), info);
      return { info, state };
    });
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
    // Copy the frozen ethers Result into a plain array: passing a Result back in as a
    // call argument throws ("Cannot assign to read only property '0'") during encoding.
    const expiries: bigint[] = [
      ...(await this.market(market).getUnpaidBatchExpiries({ blockTag: tag })),
    ];
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

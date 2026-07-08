import { formatUnits } from 'ethers';
import { WildcatConfig } from './config';
import { Chain, MarketInfo, MarketState } from './chain';

/** A borrower's market with its live default status, for selection in the UI. */
export interface MarketSummary {
  market: string;
  borrower: string;
  name: string;
  asset: string;
  assetSymbol: string;
  assetDecimals: number;
  isClosed: boolean;
  isDelinquent: boolean;
  timeDelinquent: number;
  delinquencyGracePeriod: number;
  /** Whole days the penalty APR has been active (timeDelinquent beyond the grace period). */
  penalizedDays: number;
  /** timeDelinquent >= delinquencyGracePeriod + defaultBufferSec (live). */
  inDefault: boolean;
}

/** The result of checking one lender against one market. */
export interface ClaimResult extends MarketSummary {
  account: string;
  eligible: boolean;
  heldOwedWei: string;
  withdrawalsOwedWei: string;
  withdrawalsError: boolean;
  amountOwedWei: string;
  amountOwed: string;
  asOfBlock: number;
}

export class Eligibility {
  private readonly chain: Chain;
  private readonly cfg: WildcatConfig;

  constructor(chain: Chain, cfg: WildcatConfig) {
    this.chain = chain;
    this.cfg = cfg;
  }

  /** "In default" = grace tracker has run defaultBufferSec seconds past the grace period. */
  isInDefault(state: MarketState): boolean {
    return state.timeDelinquent >= state.delinquencyGracePeriod + BigInt(this.cfg.defaultBufferSec);
  }

  private summary(info: MarketInfo, state: MarketState): MarketSummary {
    return {
      market: info.market,
      borrower: info.borrower,
      name: info.name,
      asset: info.asset,
      assetSymbol: info.assetSymbol,
      assetDecimals: info.assetDecimals,
      isClosed: state.isClosed,
      isDelinquent: state.isDelinquent,
      timeDelinquent: Number(state.timeDelinquent),
      delinquencyGracePeriod: Number(state.delinquencyGracePeriod),
      penalizedDays: Math.floor(
        Math.max(0, Number(state.timeDelinquent - state.delinquencyGracePeriod)) / 86_400
      ),
      inDefault: this.isInDefault(state),
    };
  }

  /**
   * Every market deployed by `borrower`, with live default status, for UI selection.
   * The ArchController has no borrower index, so we pull the full registry and filter
   * each market by its immutable borrower(), then load full info only for the matches.
   */
  async getBorrowerMarkets(borrower: string): Promise<MarketSummary[]> {
    const all = await this.chain.getAllMarkets();
    const target = borrower.toLowerCase();
    // One multicall for every market's borrower(), then one batched read of info+state
    // for just the matches — a handful of eth_calls total instead of O(markets).
    const borrowers = await this.chain.readBorrowers(all);
    const matches = all.filter((_, i) => (borrowers[i] ?? '').toLowerCase() === target);
    const data = await this.chain.readMarketsInfoAndState(matches);
    const summaries = data.map(({ info, state }) => this.summary(info, state));
    // Defaulted markets first, then by name.
    return summaries.sort(
      (a, b) => Number(b.inDefault) - Number(a.inDefault) || a.name.localeCompare(b.name)
    );
  }

  /**
   * Check one lender against one market. Eligible when the market is in default AND the
   * lender holds a non-dust position (market-token balance plus, when enabled, queued/
   * expired withdrawals), read live.
   */
  async eligibleClaim(account: string, market: string): Promise<ClaimResult> {
    // Resolve the block FIRST and pin every read to it. Reading at 'latest' while stamping a
    // separately-fetched block number lets the figures come from a different block than the
    // signature commits to, so an honest lender's proof would fail archive replay (interest
    // accrues per second) and held/withdrawals could straddle a queueWithdrawal tx.
    const asOfBlock = await this.chain.resolveAsOfBlock();
    const [info, state] = await Promise.all([
      this.chain.getMarketInfo(market),
      this.chain.getMarketState(market, asOfBlock),
    ]);

    let heldWei = await this.chain.readLenderHeld(market, account, asOfBlock);
    let withdrawalsWei = 0n;
    let withdrawalsError = false;
    if (this.cfg.includeWithdrawals) {
      try {
        withdrawalsWei = await this.chain.readWithdrawalsOwed(market, account, asOfBlock);
      } catch (err: any) {
        withdrawalsError = true;
        console.error(`Withdrawal read failed for ${market}/${account}: ${err.message}`);
      }
    }

    // DEBUG ONLY: assume the lender holds >= 100 underlying so the signing flow is testable
    // without a real position. Does not bypass signature verification or the default gate.
    if (this.cfg.debugMode) {
      const floor = 100n * 10n ** BigInt(info.assetDecimals);
      if (heldWei + withdrawalsWei < floor) heldWei = floor - withdrawalsWei;
    }

    const owed = heldWei + withdrawalsWei;
    const summary = this.summary(info, state);
    // Non-zero holdings are a sufficient gate: anyone with a position is an impacted lender
    // and is entitled to the data. Default status (inDefault/penalizedDays) is reported as
    // context but does not gate eligibility. (DEBUG_MODE still floors holdings for testing.)
    const eligible = owed > this.cfg.minOwedWei;

    return {
      ...summary,
      account,
      eligible,
      heldOwedWei: heldWei.toString(),
      withdrawalsOwedWei: withdrawalsWei.toString(),
      withdrawalsError,
      amountOwedWei: owed.toString(),
      amountOwed: formatUnits(owed, info.assetDecimals),
      asOfBlock,
    };
  }
}

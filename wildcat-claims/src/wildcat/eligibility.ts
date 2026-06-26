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
    const borrowers = await Promise.all(all.map((m) => this.chain.readBorrower(m)));
    const matches = all.filter((_, i) => borrowers[i].toLowerCase() === target);
    const summaries = await Promise.all(
      matches.map(async (m) =>
        this.summary(await this.chain.getMarketInfo(m), await this.chain.getMarketState(m))
      )
    );
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
    const [info, state, asOfBlock] = await Promise.all([
      this.chain.getMarketInfo(market),
      this.chain.getMarketState(market),
      this.chain.resolveAsOfBlock(),
    ]);

    let heldWei = await this.chain.readLenderHeld(market, account);
    let withdrawalsWei = 0n;
    let withdrawalsError = false;
    if (this.cfg.includeWithdrawals) {
      try {
        withdrawalsWei = await this.chain.readWithdrawalsOwed(market, account);
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
    // Normally a market must be in default; DEBUG_MODE relaxes that so the signing flow
    // can be exercised against a not-yet-defaulted (but penalized-delinquent) market.
    const eligible = (summary.inDefault || this.cfg.debugMode) && owed > this.cfg.minOwedWei;

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

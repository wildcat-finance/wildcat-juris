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

    const heldWei = await this.chain.readLenderHeld(market, account);
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

    const owed = heldWei + withdrawalsWei;
    const summary = this.summary(info, state);
    const eligible = summary.inDefault && owed > this.cfg.minOwedWei;

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

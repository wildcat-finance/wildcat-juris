import { formatUnits } from 'ethers';
import { WildcatConfig } from './config';
import { Chain } from './chain';

/** A lender's eligible claim against a single in-scope market. */
export interface EligibleClaim {
  market: string;
  borrower: string;
  asset: string;
  assetSymbol: string;
  assetDecimals: number;
  /** Total owed (held + withdrawals), human-readable in asset units. */
  amountOwed: string;
  /** Total owed (held + withdrawals), raw wei as a decimal string. */
  amountOwedWei: string;
  /** Held market-token position, raw wei. */
  heldOwedWei: string;
  /** Share of queued/expired withdrawal batches, raw wei. */
  withdrawalsOwedWei: string;
  /** True if the withdrawal figure may be incomplete (read error). */
  withdrawalsError: boolean;
  // Reported delinquency metadata (not an eligibility gate under per-market scoping).
  isClosed: boolean;
  isDelinquent: boolean;
  penaltyActive: boolean;
  timeDelinquent: number;
  delinquencyGracePeriod: number;
}

export interface EligibilityResult {
  account: string;
  network: string;
  /** Block the reads were pinned to (audit trail). */
  blockNumber: number;
  /** Eligibility threshold (unix seconds), or null when reading at 'latest'. */
  eligibilityTimestamp: number | null;
  totalOwedWei: string;
  claims: EligibleClaim[];
}

export class Eligibility {
  private readonly chain: Chain;
  private readonly cfg: WildcatConfig;
  private scopedMarkets?: string[];

  constructor(chain: Chain, cfg: WildcatConfig) {
    this.chain = chain;
    this.cfg = cfg;
  }

  /**
   * The in-scope markets for this incident. Uses the configured set (per-market
   * scoping); if none is configured, falls back to enumerating every registered
   * market. The set is fixed for a given incident, so it is memoised.
   */
  async getScopedMarkets(force = false): Promise<string[]> {
    if (this.scopedMarkets && !force) return this.scopedMarkets;
    if (this.cfg.scopedMarkets.length > 0) {
      this.scopedMarkets = this.cfg.scopedMarkets;
    } else {
      console.warn('SCOPED_MARKETS is empty — falling back to all registered markets.');
      this.scopedMarkets = await this.chain.getAllMarkets();
    }
    return this.scopedMarkets;
  }

  /**
   * Every in-scope market in which `account` held a non-dust position (market-token
   * balance plus, when enabled, queued/expired withdrawals) as of the eligibility
   * block. Closed-but-unpaid markets are included; there is no live-distress gate —
   * the incident's market scope defines who is in scope.
   */
  async eligibleClaims(account: string): Promise<EligibilityResult> {
    const [markets, blockNumber] = await Promise.all([
      this.getScopedMarkets(),
      this.chain.resolveEligibilityBlock(),
    ]);

    const maybeClaims = await Promise.all(
      markets.map(async (market): Promise<EligibleClaim | undefined> => {
        const { snapshot, heldWei, withdrawalsWei, withdrawalsError } =
          await this.chain.readEligibilityData(market, account);
        const owed = heldWei + withdrawalsWei;
        if (owed <= this.cfg.minOwedWei) return undefined;
        return {
          market: snapshot.market,
          borrower: snapshot.borrower,
          asset: snapshot.asset,
          assetSymbol: snapshot.assetSymbol,
          assetDecimals: snapshot.assetDecimals,
          amountOwed: formatUnits(owed, snapshot.assetDecimals),
          amountOwedWei: owed.toString(),
          heldOwedWei: heldWei.toString(),
          withdrawalsOwedWei: withdrawalsWei.toString(),
          withdrawalsError,
          isClosed: snapshot.isClosed,
          isDelinquent: snapshot.isDelinquent,
          penaltyActive: snapshot.penaltyActive,
          timeDelinquent: Number(snapshot.timeDelinquent),
          delinquencyGracePeriod: Number(snapshot.delinquencyGracePeriod),
        };
      })
    );

    const claims = maybeClaims.filter((c): c is EligibleClaim => c !== undefined);
    const totalOwedWei = claims.reduce((acc, c) => acc + BigInt(c.amountOwedWei), 0n);

    return {
      account,
      network: this.cfg.network,
      blockNumber,
      eligibilityTimestamp: this.cfg.eligibilityTimestamp ?? null,
      totalOwedWei: totalOwedWei.toString(),
      claims,
    };
  }
}

import { describe, it, expect } from 'vitest';
import { Eligibility } from '../src/wildcat/eligibility';
import { computeMarketsHash } from '../src/utils';
import type { Chain, MarketSnapshot, MarketLenderData } from '../src/wildcat/chain';
import type { WildcatConfig } from '../src/wildcat/config';

const baseCfg: WildcatConfig = {
  network: 'mainnet',
  rpcUrl: 'http://localhost',
  addresses: { archController: '', marketLens: '', hooksFactory: '', sanctionsSentinel: '' },
  scopedMarkets: [],
  eligibilityTimestamp: 1_700_000_000,
  incidentId: 'test',
  includeWithdrawals: true,
  minOwedWei: 0n,
  lensMode: 'lens',
};

const snap = (over: Partial<MarketSnapshot>): MarketSnapshot => ({
  market: '0xMARKET',
  borrower: '0xBORROWER',
  asset: '0xASSET',
  assetSymbol: 'TOK',
  assetDecimals: 18,
  isClosed: false,
  isDelinquent: false,
  timeDelinquent: 0n,
  delinquencyGracePeriod: 1000n,
  penaltyActive: false,
  ...over,
});

const md = (
  market: string,
  heldWei: bigint,
  withdrawalsWei = 0n,
  over: Partial<MarketSnapshot> = {}
): MarketLenderData => ({
  snapshot: snap({ market, ...over }),
  heldWei,
  withdrawalsWei,
  withdrawalsError: false,
});

function fakeChain(data: Record<string, MarketLenderData>, block = 12345): Chain {
  return {
    resolveEligibilityBlock: async () => block,
    getAllMarkets: async () => Object.keys(data),
    readEligibilityData: async (market: string) => data[market],
  } as unknown as Chain;
}

describe('eligibleClaims (per-market + timestamp scoping)', () => {
  it('includes scoped markets with a non-dust position and sums held + withdrawals', async () => {
    const data = {
      '0xHELD': md('0xHELD', 100n), // held only -> 100
      '0xWD': md('0xWD', 0n, 50n), // withdrawals only -> 50
      '0xBOTH': md('0xBOTH', 30n, 20n), // held + withdrawals -> 50
      '0xCLOSED': md('0xCLOSED', 70n, 0n, { isClosed: true }), // closed-but-unpaid -> included
      '0xEMPTY': md('0xEMPTY', 0n, 0n), // nothing -> excluded
    };
    const cfg = { ...baseCfg, scopedMarkets: Object.keys(data) };
    const e = new Eligibility(fakeChain(data), cfg);
    const result = await e.eligibleClaims('0xLENDER');

    expect(result.claims.map((c) => c.market).sort()).toEqual(['0xBOTH', '0xCLOSED', '0xHELD', '0xWD']);
    expect(result.totalOwedWei).toBe('270'); // 100 + 50 + 50 + 70
    expect(result.blockNumber).toBe(12345);
    expect(result.eligibilityTimestamp).toBe(1_700_000_000);

    const both = result.claims.find((c) => c.market === '0xBOTH')!;
    expect(both.heldOwedWei).toBe('30');
    expect(both.withdrawalsOwedWei).toBe('20');
    expect(both.amountOwedWei).toBe('50');
  });

  it('has no live-distress gate: a healthy scoped market with a balance is still eligible', async () => {
    const data = { '0xHEALTHY': md('0xHEALTHY', 42n) }; // isDelinquent=false, penaltyActive=false
    const cfg = { ...baseCfg, scopedMarkets: ['0xHEALTHY'] };
    const e = new Eligibility(fakeChain(data), cfg);
    const result = await e.eligibleClaims('0xLENDER');
    expect(result.claims).toHaveLength(1);
    expect(result.totalOwedWei).toBe('42');
  });

  it('respects the dust threshold against the combined held + withdrawals total', async () => {
    const data = {
      '0xUNDER': md('0xUNDER', 5n, 4n), // 9 -> excluded
      '0xOVER': md('0xOVER', 5n, 6n), // 11 -> included
    };
    const cfg = { ...baseCfg, scopedMarkets: Object.keys(data), minOwedWei: 10n };
    const e = new Eligibility(fakeChain(data), cfg);
    const result = await e.eligibleClaims('0xLENDER');
    expect(result.claims.map((c) => c.market)).toEqual(['0xOVER']);
  });

  it('falls back to enumerating all markets when no scope is configured', async () => {
    const data = { '0xA': md('0xA', 10n), '0xB': md('0xB', 0n) };
    const e = new Eligibility(fakeChain(data), { ...baseCfg, scopedMarkets: [] });
    const markets = await e.getScopedMarkets();
    expect(markets.sort()).toEqual(['0xA', '0xB']); // discovered via getAllMarkets
    const result = await e.eligibleClaims('0xLENDER');
    expect(result.claims.map((c) => c.market)).toEqual(['0xA']);
  });
});

describe('computeMarketsHash', () => {
  it('is order-independent and case-insensitive', () => {
    expect(computeMarketsHash(['0xAbC', '0xDeF'])).toBe(computeMarketsHash(['0xdef', '0xabc']));
  });
  it('differs for different market sets', () => {
    expect(computeMarketsHash(['0xabc'])).not.toBe(computeMarketsHash(['0xabc', '0xdef']));
  });
});

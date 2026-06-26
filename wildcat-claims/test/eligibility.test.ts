import { describe, it, expect } from 'vitest';
import { Eligibility } from '../src/wildcat/eligibility';
import type { Chain, MarketInfo, MarketState } from '../src/wildcat/chain';
import type { WildcatConfig } from '../src/wildcat/config';

const BUFFER = 90 * 86_400; // 7,776,000s

const baseCfg: WildcatConfig = {
  network: 'mainnet',
  rpcUrl: 'http://localhost',
  addresses: { archController: '', marketLens: '', hooksFactory: '', sanctionsSentinel: '' },
  defaultBufferSec: BUFFER,
  includeWithdrawals: true,
  minOwedWei: 0n,
  lensMode: 'lens',
};

const info = (market: string, over: Partial<MarketInfo> = {}): MarketInfo => ({
  market,
  borrower: '0xBORROWER',
  name: 'Market ' + market,
  asset: '0xASSET',
  assetSymbol: 'TOK',
  assetDecimals: 18,
  ...over,
});

const state = (over: Partial<MarketState> = {}): MarketState => ({
  isClosed: false,
  isDelinquent: true,
  timeDelinquent: 0n,
  delinquencyGracePeriod: 1000n,
  ...over,
});

// timeDelinquent values that sit either side of the default line (grace = 1000).
const DEFAULTED = BigInt(1000 + BUFFER); // exactly at the threshold -> in default
const NOT_DEFAULTED = 2000n; // past grace (penalty) but not yet in default

interface FakeOpts {
  infos?: Record<string, MarketInfo>;
  states?: Record<string, MarketState>;
  held?: Record<string, bigint>;
  withdrawals?: Record<string, bigint>;
  block?: number;
}

function fakeChain(o: FakeOpts): Chain {
  return {
    resolveAsOfBlock: async () => o.block ?? 999,
    getAllMarkets: async () => Object.keys(o.infos ?? {}),
    readBorrower: async (m: string) => o.infos![m].borrower,
    getMarketInfo: async (m: string) => o.infos![m],
    getMarketState: async (m: string) => o.states![m],
    readLenderHeld: async (m: string) => o.held?.[m] ?? 0n,
    readWithdrawalsOwed: async (m: string) => o.withdrawals?.[m] ?? 0n,
  } as unknown as Chain;
}

describe('eligibleClaim (live default gate)', () => {
  it('is eligible when the market is in default and the lender holds a non-dust balance', async () => {
    const chain = fakeChain({
      infos: { '0xM': info('0xM') },
      states: { '0xM': state({ timeDelinquent: DEFAULTED }) },
      held: { '0xM': 100n },
      block: 12345,
    });
    const r = await new Eligibility(chain, baseCfg).eligibleClaim('0xLENDER', '0xM');
    expect(r.inDefault).toBe(true);
    expect(r.eligible).toBe(true);
    expect(r.amountOwedWei).toBe('100');
    expect(r.asOfBlock).toBe(12345);
  });

  it('sums held + withdrawals into the owed total', async () => {
    const chain = fakeChain({
      infos: { '0xM': info('0xM') },
      states: { '0xM': state({ timeDelinquent: DEFAULTED }) },
      held: { '0xM': 30n },
      withdrawals: { '0xM': 20n },
    });
    const r = await new Eligibility(chain, baseCfg).eligibleClaim('0xLENDER', '0xM');
    expect(r.heldOwedWei).toBe('30');
    expect(r.withdrawalsOwedWei).toBe('20');
    expect(r.amountOwedWei).toBe('50');
    expect(r.eligible).toBe(true);
  });

  it('is NOT eligible when the market is not in default, even with a balance', async () => {
    const chain = fakeChain({
      infos: { '0xM': info('0xM') },
      states: { '0xM': state({ timeDelinquent: NOT_DEFAULTED }) },
      held: { '0xM': 100n },
    });
    const r = await new Eligibility(chain, baseCfg).eligibleClaim('0xLENDER', '0xM');
    expect(r.inDefault).toBe(false);
    expect(r.eligible).toBe(false);
  });

  it('is NOT eligible when in default but the lender holds nothing', async () => {
    const chain = fakeChain({
      infos: { '0xM': info('0xM') },
      states: { '0xM': state({ timeDelinquent: DEFAULTED }) },
      held: { '0xM': 0n },
    });
    const r = await new Eligibility(chain, baseCfg).eligibleClaim('0xLENDER', '0xM');
    expect(r.eligible).toBe(false);
  });

  it('respects the dust threshold on the combined total', async () => {
    const chain = fakeChain({
      infos: { '0xM': info('0xM') },
      states: { '0xM': state({ timeDelinquent: DEFAULTED }) },
      held: { '0xM': 5n },
      withdrawals: { '0xM': 4n }, // 9 < 10
    });
    const r = await new Eligibility(chain, { ...baseCfg, minOwedWei: 10n }).eligibleClaim('0xLENDER', '0xM');
    expect(r.eligible).toBe(false);
  });
});

describe('getBorrowerMarkets', () => {
  it('filters the registry by borrower() (case-insensitive), flags default, defaulted first', async () => {
    const infos = {
      '0xHEALTHY': info('0xHEALTHY', { name: 'Zebra', borrower: '0xBob' }),
      '0xDEFAULT': info('0xDEFAULT', { name: 'Alpha', borrower: '0xBob' }),
      '0xOTHER': info('0xOTHER', { borrower: '0xSomeoneElse' }),
    };
    const states = {
      '0xHEALTHY': state({ timeDelinquent: 0n, isDelinquent: false }),
      '0xDEFAULT': state({ timeDelinquent: DEFAULTED }),
      // no state for 0xOTHER — it must be filtered out before any state read
    };
    const chain = fakeChain({ infos, states });
    const out = await new Eligibility(chain, baseCfg).getBorrowerMarkets('0xBOB'); // different case

    expect(out.map((m) => m.market)).toEqual(['0xDEFAULT', '0xHEALTHY']); // defaulted first, 0xOTHER excluded
    expect(out.find((m) => m.market === '0xDEFAULT')!.inDefault).toBe(true);
    expect(out.find((m) => m.market === '0xHEALTHY')!.inDefault).toBe(false);
  });
});

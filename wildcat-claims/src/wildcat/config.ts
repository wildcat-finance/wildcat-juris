import { getAddress } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

export interface WildcatAddresses {
  archController: string;
  marketLens: string;
  hooksFactory: string;
  sanctionsSentinel: string;
  /** Multicall3 — same canonical address on most chains; batches the discovery reads. */
  multicall3: string;
}

/** How the per-market/per-lender reads are performed. */
export type LensMode = 'lens' | 'direct';

export interface WildcatConfig {
  network: string;
  /** EIP-155 chain id for the network (mainnet=1, sepolia=11155111). */
  chainId: number;
  rpcUrl: string;
  addresses: WildcatAddresses;

  /**
   * A market is "in default" when its grace tracker has run this many seconds past
   * the grace period: timeDelinquent >= delinquencyGracePeriod + defaultBufferSec.
   * Evaluated live. Default: 90 days.
   */
  defaultBufferSec: number;

  /**
   * Optional borrower address to pre-fill on the frontend. The borrower's markets are
   * discovered on-chain; lenders then pick one. If unset, the field starts empty.
   */
  borrower?: string;

  /** Optional block override for reads (audit/testing). Undefined => 'latest' (live). */
  snapshotBlock?: number;

  /** Include queued/expired withdrawal-batch amounts in a lender's owed total. */
  includeWithdrawals: boolean;

  /** Ignore positions below this many wei of the underlying asset. */
  minOwedWei: bigint;

  /** Primary read path. 'lens' uses MarketLens; 'direct' uses currentState()+balanceOf. */
  lensMode: LensMode;

  /**
   * Per-request RPC timeout in ms. Must stay well under the serverless function's maxDuration
   * (30s in vercel.json), because ethers' own default is 300s: a node that accepts connections
   * and answers header methods but stalls on state reads would otherwise consume the whole
   * function budget and surface as an opaque FUNCTION_INVOCATION_TIMEOUT rather than a
   * diagnosable RPC error. Env: RPC_TIMEOUT_MS.
   */
  rpcTimeoutMs: number;

  /**
   * Bearer token for an authenticated RPC gateway. rpc.wildcat.finance sits behind one
   * (`WWW-Authenticate: Bearer realm="wildcat-gateway"`) and answers 401 in ~0.1s without it,
   * so a missing token is a configuration error the app should name rather than a node fault.
   * Env: RPC_BEARER_TOKEN. Unset is correct for an open endpoint.
   */
  rpcBearerToken?: string;

  /**
   * DEBUG (testing only): when true, any lender being checked is assumed to hold >= 100 of
   * the underlying in every market, so testers can exercise the claim-signing flow without a
   * real position. Signatures are still verified normally. Env: DEBUG_MODE. Off in production.
   *
   * Process-wide, so it fakes eligibility for every visitor at once: use it locally, never on
   * the hosted site. For a dry run against production use `debugKey` instead.
   */
  debugMode: boolean;

  /**
   * Shared secret that lets one browser open a debug session — the same fudge as `debugMode`,
   * scoped to whoever holds the secret, so ordinary visitors keep seeing honest reads while
   * the team dry-runs the flow. Env: DEBUG_KEY. Unset (the default, including production)
   * makes debug sessions unreachable and /debug/session indistinguishable from a dead route.
   * See src/debugSession.ts for how one is opened.
   */
  debugKey?: string;
}

/**
 * Canonical Wildcat V2 deployments. Source of truth:
 * https://docs.wildcat.finance (Mainnet [V2]).
 */
const DEPLOYMENTS: Record<string, WildcatAddresses> = {
  mainnet: {
    archController: '0xfEB516d9D946dD487A9346F6fee11f40C6945eE4',
    marketLens: '0xfDA5C5B96bb198D2fca1A01d759620B64Ae5afE7',
    hooksFactory: '0xdd7dd3b5076cf89440d05585ff56d246386207be',
    sanctionsSentinel: '0x437e0551892C2C9b06d3fFd248fe60572e08CD1A',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  },
  // Sepolia: ArchController must be supplied via env until confirmed from a live deploy.
  sepolia: {
    archController: process.env.ARCH_CONTROLLER ?? '',
    marketLens: process.env.MARKET_LENS ?? '0xa47237531fae13c82a4361d68aa1e53fc939d70f',
    hooksFactory: process.env.HOOKS_FACTORY ?? '0xe3e4b7c9e0ab4ccbc70e0583dca7b4db9b4cfd88',
    sanctionsSentinel: process.env.SANCTIONS_SENTINEL ?? '',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  },
};

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env/config value: ${name}`);
  return value;
}

const DAY_SEC = 86_400;

export function loadConfig(): WildcatConfig {
  const network = process.env.WILDCAT_NETWORK ?? 'mainnet';
  const base = DEPLOYMENTS[network];
  if (!base) throw new Error(`Unknown WILDCAT_NETWORK: ${network}`);

  const addresses: WildcatAddresses = {
    archController: getAddress(
      required('ARCH_CONTROLLER', process.env.ARCH_CONTROLLER ?? base.archController)
    ),
    marketLens: getAddress(required('MARKET_LENS', process.env.MARKET_LENS ?? base.marketLens)),
    hooksFactory: getAddress(required('HOOKS_FACTORY', process.env.HOOKS_FACTORY ?? base.hooksFactory)),
    sanctionsSentinel: base.sanctionsSentinel
      ? getAddress(process.env.SANCTIONS_SENTINEL ?? base.sanctionsSentinel)
      : '',
    multicall3: getAddress(process.env.MULTICALL3 ?? base.multicall3),
  };

  const lensMode: LensMode = (process.env.LENS_MODE ?? 'lens') === 'direct' ? 'direct' : 'lens';
  const bufferDays = Number(process.env.DEFAULT_BUFFER_DAYS ?? '90');

  return {
    network,
    chainId: network === 'sepolia' ? 11155111 : 1,
    // The Wildcat gateway. Authenticated: see rpcBearerToken. Override with RPC_URL — the
    // previous default, eth-main.hinterlight.net, is open but was serving headers only.
    rpcUrl: process.env.RPC_URL || 'https://rpc.wildcat.finance/',
    addresses,
    defaultBufferSec: Math.floor(bufferDays * DAY_SEC),
    borrower: process.env.BORROWER_ADDRESS ? getAddress(process.env.BORROWER_ADDRESS) : undefined,
    snapshotBlock: process.env.SNAPSHOT_BLOCK ? Number(process.env.SNAPSHOT_BLOCK) : undefined,
    includeWithdrawals: (process.env.INCLUDE_WITHDRAWALS ?? 'true').toLowerCase() !== 'false',
    minOwedWei: BigInt(process.env.MIN_OWED_WEI ?? '0'),
    lensMode,
    rpcTimeoutMs: Math.max(1_000, Number(process.env.RPC_TIMEOUT_MS ?? '8000') || 8_000),
    rpcBearerToken: (process.env.RPC_BEARER_TOKEN ?? '').trim() || undefined,
    debugMode: ['1', 'true', 'yes'].includes((process.env.DEBUG_MODE ?? '').toLowerCase()),
    // A short key is worse than none: it invites guessing at a gate that fakes eligibility.
    debugKey: (process.env.DEBUG_KEY ?? '').trim().length >= 24
      ? (process.env.DEBUG_KEY ?? '').trim()
      : undefined,
  };
}

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
   * DEBUG (testing only): when true, any lender being checked is assumed to hold >= 100 of
   * the underlying in every market, so testers can exercise the claim-signing flow without a
   * real position. Signatures are still verified normally. Env: DEBUG_MODE. Off in production.
   */
  debugMode: boolean;
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
    // Defaults to the Wildcat mainnet archive node; override with the RPC_URL env var.
    rpcUrl: process.env.RPC_URL || 'https://eth-main.hinterlight.net/',
    addresses,
    defaultBufferSec: Math.floor(bufferDays * DAY_SEC),
    borrower: process.env.BORROWER_ADDRESS ? getAddress(process.env.BORROWER_ADDRESS) : undefined,
    snapshotBlock: process.env.SNAPSHOT_BLOCK ? Number(process.env.SNAPSHOT_BLOCK) : undefined,
    includeWithdrawals: (process.env.INCLUDE_WITHDRAWALS ?? 'true').toLowerCase() !== 'false',
    minOwedWei: BigInt(process.env.MIN_OWED_WEI ?? '0'),
    lensMode,
    debugMode: ['1', 'true', 'yes'].includes((process.env.DEBUG_MODE ?? '').toLowerCase()),
  };
}

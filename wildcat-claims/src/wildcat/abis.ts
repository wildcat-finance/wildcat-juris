/**
 * Human-readable ABI fragments (ethers v6) for the calls this service makes.
 *
 * All markets in scope are Wildcat V2 (hooks-based) markets, read via MarketLensV2
 * (mainnet 0xfDA5C5B96bb198D2fca1A01d759620B64Ae5afE7). ABI shapes below are taken
 * from the Wildcat TypeScript SDK (contracts/MarketLensV2.sol, MarketLensStructs.sol,
 * WildcatMarketV2 typechain) — i.e. authoritative, not reconstructed.
 *
 * Two read paths are supported for the held balance (see LENS_MODE):
 *   - 'lens'   — MarketLensV2.getLenderAccountData(lender, market).normalizedBalance.
 *   - 'direct' — market.balanceOf(lender), the fallback.
 * Withdrawal amounts always come from the lens (authoritative normalizedAmountOwed).
 */

export const ARCH_CONTROLLER_ABI = [
  'function getRegisteredMarketsCount() view returns (uint256)',
  // No-arg overload returns the full set in one call (selector 0x46762101); the
  // paginated overload is kept as a fallback for very large registries.
  'function getRegisteredMarkets() view returns (address[])',
  'function getRegisteredMarkets(uint256 start, uint256 end) view returns (address[])',
  'function isRegisteredMarket(address market) view returns (bool)',
  'function getRegisteredBorrowersCount() view returns (uint256)',
  'function getRegisteredBorrowers(uint256 start, uint256 end) view returns (address[])',
  'event MarketAdded(address indexed controller, address market)',
  'event MarketRemoved(address market)',
];

/**
 * WildcatMarketV2. `currentState()` returns the live MarketState (interest/fees/
 * delinquency replayed to block.timestamp, no storage write). Field order/types match
 * the DEPLOYED market ABI exactly (13 fields — note there is NO protocolFeeBips here,
 * despite the SDK typechain's MarketStateV2Struct; the on-chain ABI is authoritative).
 */
export const MARKET_ABI = [
  'function currentState() view returns (tuple(' +
    'bool isClosed,' +
    'uint128 maxTotalSupply,' +
    'uint128 accruedProtocolFees,' +
    'uint128 normalizedUnclaimedWithdrawals,' +
    'uint104 scaledTotalSupply,' +
    'uint104 scaledPendingWithdrawals,' +
    'uint32 pendingWithdrawalExpiry,' +
    'bool isDelinquent,' +
    'uint32 timeDelinquent,' +
    'uint16 annualInterestBips,' +
    'uint16 reserveRatioBips,' +
    'uint112 scaleFactor,' +
    'uint32 lastInterestAccruedTimestamp))',
  'function borrower() view returns (address)',
  'function asset() view returns (address)',
  'function name() view returns (string)',
  'function balanceOf(address account) view returns (uint256)',
  'function delinquencyGracePeriod() view returns (uint256)',
  'function getUnpaidBatchExpiries() view returns (uint32[])',
];

export const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

/**
 * MarketLensV2 (subset). Shapes from contracts/MarketLensV2.sol + MarketLensStructs.sol.
 *
 * - getLenderAccountData(lender, market) -> LenderAccountData: the lender's position;
 *   we read `normalizedBalance`. (Avoids decoding the large MarketDataV2 struct that
 *   getMarketDataWithLenderStatus would also return.)
 * - getWithdrawalBatchesDataWithLenderStatus(market, expiries, lender) -> per-batch
 *   status; we sum `lenderStatus.normalizedAmountOwed` (authoritative withdrawal owed).
 */
export const LENS_ABI = [
  'function getLenderAccountData(address lender, address market) view returns (' +
    'tuple(' +
      'address lender,' +
      'uint256 scaledBalance,' +
      'uint256 normalizedBalance,' +
      'uint256 underlyingBalance,' +
      'uint256 underlyingApproval,' +
      'bool isBlockedFromDeposits,' +
      'tuple(uint32 timeToLive, address providerAddress, uint24 pullProviderIndex, uint24 pushProviderIndex) lastProvider,' +
      'bool canRefresh,' +
      'uint32 lastApprovalTimestamp,' +
      'bool isKnownLender' +
    '))',
  'function getWithdrawalBatchesDataWithLenderStatus(address market, uint32[] expiries, address lender) view returns (' +
    'tuple(' +
      'tuple(uint32 expiry, uint8 status, uint256 scaledTotalAmount, uint256 scaledAmountBurned, uint256 normalizedAmountPaid, uint256 normalizedTotalAmount) batch,' +
      'tuple(address lender, uint256 scaledAmount, uint256 normalizedAmountWithdrawn, uint256 normalizedAmountOwed, uint256 availableWithdrawalAmount) lenderStatus' +
    ')[])',
];

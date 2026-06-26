/**
 * Human-readable ABI fragments (ethers v6) for the calls this service makes.
 *
 * Two read paths are supported (see LENS_MODE in config):
 *   - 'lens'   — MarketLens.getMarketDataWithLenderStatus, one eth_call per market.
 *   - 'direct' — per-market currentState() + balanceOf, the verified fallback whose
 *                shapes match v2-protocol/src exactly.
 */

export const ARCH_CONTROLLER_ABI = [
  'function getRegisteredMarketsCount() view returns (uint256)',
  'function getRegisteredMarkets(uint256 start, uint256 end) view returns (address[])',
  'function isRegisteredMarket(address market) view returns (bool)',
  'function getRegisteredBorrowersCount() view returns (uint256)',
  'function getRegisteredBorrowers(uint256 start, uint256 end) view returns (address[])',
  'event MarketAdded(address indexed controller, address market)',
  'event MarketRemoved(address market)',
];

/**
 * `currentState()` returns the live MarketState (interest/fees/delinquency replayed
 * to block.timestamp, no storage write). Field order matches
 * v2-protocol/src/libraries/MarketState.sol exactly — this is the verified path.
 *
 * The withdrawal getters below are used to fold queued/expired withdrawal-batch
 * amounts into a lender's owed total. NOTE: these struct shapes are taken from
 * WildcatMarketWithdrawals in v2-protocol; confirm against the deployed artifact
 * before relying on the withdrawal figures for legal purposes.
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
    'uint16 protocolFeeBips,' +
    'uint16 annualInterestBips,' +
    'uint16 reserveRatioBips,' +
    'uint112 scaleFactor,' +
    'uint32 lastInterestAccruedTimestamp))',
  'function borrower() view returns (address)',
  'function asset() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function scaledBalanceOf(address account) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function delinquencyFeeBips() view returns (uint256)',
  'function delinquencyGracePeriod() view returns (uint256)',
  // --- withdrawal surface (verify struct shapes against the deployed artifact) ---
  'function getUnpaidBatchExpiries() view returns (uint32[])',
  'function getWithdrawalBatch(uint32 expiry) view returns (tuple(' +
    'uint128 scaledTotalAmount,' +
    'uint128 scaledAmountBurned,' +
    'uint128 normalizedAmountPaid))',
  'function getAccountWithdrawalStatus(address account, uint32 expiry) view returns (tuple(' +
    'uint104 scaledAmount,' +
    'uint128 normalizedAmountWithdrawn))',
];

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
];

/**
 * ===========================  RECONSTRUCTED — VERIFY  ===========================
 * MarketLens.getMarketDataWithLenderStatus(lender, market) returns a large nested
 * (MarketData, LenderAccountData) pair. The exact field order/types are defined in
 * v2-protocol/src/lens/ and are NOT bundled in this repo, so the structs below are a
 * best-effort reconstruction from WILDCAT_PROTOCOL_ARCHITECTURE.md.
 *
 * TO FINALISE: paste the `.abi` entry for `getMarketDataWithLenderStatus` from
 * `v2-protocol/out/MarketLens.sol/MarketLens.json` over LENS_ABI below.
 *
 * Until verified, chain.ts reads only a handful of named fields and, if the decode
 * fails, automatically falls back to the verified 'direct' path (logged once).
 * ================================================================================
 */
export const LENS_ABI = [
  'function getMarketDataWithLenderStatus(address lender, address market) view returns (' +
    'tuple(' +
      'address market,' +
      'address borrower,' +
      'address asset,' +
      'string name,' +
      'string symbol,' +
      'uint8 decimals,' +
      'string assetName,' +
      'string assetSymbol,' +
      'uint8 assetDecimals,' +
      'bool isClosed,' +
      'bool isDelinquent,' +
      'uint256 timeDelinquent,' +
      'uint256 delinquencyGracePeriod,' +
      'uint256 reserveRatioBips,' +
      'uint256 annualInterestBips,' +
      'uint256 delinquencyFeeBips,' +
      'uint256 scaleFactor,' +
      'uint256 totalSupply,' +
      'uint256 totalAssets,' +
      'uint256 coverageLiquidity' +
    ') marketData,' +
    'tuple(' +
      'uint256 scaledBalance,' +
      'uint256 normalizedBalance,' +
      'uint256 underlyingBalance,' +
      'uint256 underlyingApproval,' +
      'bool isBlockedFromDeposits,' +
      'bool isKnownLender' +
    ') lenderStatus)',
];

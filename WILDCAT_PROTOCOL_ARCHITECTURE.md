# Wildcat V2 — On-Chain Architecture for Claim Tooling

This documents the parts of the Wildcat V2 protocol a claim-intake tool needs to read: how markets are enumerated, how they are attributed to borrowers, and how delinquency/penalty state is observed on-chain. All names below are real contract/struct/function identifiers from `v2-protocol/src`.

## Key addresses (mainnet)

| Contract | Address |
|---|---|
| `WildcatArchController` | `0xfEB516d9D946dD487A9346F6fee11f40C6945eE4` |
| `WildcatSanctionsSentinel` | `0x437e0551892C2C9b06d3fFd248fe60572e08CD1A` |
| `HooksFactory` | *not in repo deployments.json — confirm from live deployment* |
| `MarketLens` | *not in repo deployments.json — confirm from live deployment* |

The ArchController is the only address strictly required to bootstrap discovery; everything else can be derived from it or from the markets it lists. (Sepolia deployments in the repo include `MarketLens` and `HooksFactory` addresses for testing.)

## 1. Market identification — the ArchController as registry

`WildcatArchController` is the single global registry and permission gate. It holds five `EnumerableSet`s: `_markets`, `_controllers`, `_controllerFactories`, `_borrowers`, and `_assetBlacklist`.

The canonical "what markets exist" question is answered entirely here:

- `getRegisteredMarkets()` — all market addresses; paginated overload `getRegisteredMarkets(start, end)`; `getRegisteredMarketsCount()`.
- `isRegisteredMarket(address)` — membership check.

Markets are added via `registerMarket(market)`, guarded by `onlyController` (caller must be in `_controllers`). It emits `MarketAdded(address indexed controller, address market)` / `MarketRemoved(address market)`.

**Subtlety that matters for indexing:** in V2's hooks-based model, the entity registered as a "controller" is the **`HooksFactory`** itself (it calls `registerWithArchController()` → `archController.registerController(...)` once at deploy). So `MarketAdded` is indexed by the *factory*, not the borrower. The ArchController tells you which markets exist and who may deploy — **it does not store the borrower↔market mapping.**

## 2. Tying markets to individual borrowers

Borrowers are gated by the ArchController (`registerBorrower` / `removeBorrower`, `onlyOwner`; `isRegisteredBorrower` is checked on every deploy), but the borrower→market linkage lives in two other places:

1. **On the market itself** — `address public immutable borrower`, stamped at deploy time. In `HooksFactory._deployMarket` the borrower is set to `msg.sender` and baked into the market immutables (read back through `getMarketParameters`). For any market, call `market.borrower()`.
2. **In the HooksFactory** — `_hooksInstancesByBorrower[borrower] → hooksInstances`, then `_marketsByHooksInstance[hooksInstance] → markets` (also `_marketsByHooksTemplate`). Reachable via `getHooksInstancesForBorrower(borrower)` + `getMarketsForHooksInstance(hooksInstance)`.

Deploy path that creates the linkage: a registered borrower calls `deployMarket` / `deployMarketAndHooks`; the factory computes a CREATE2 address (the `salt` must embed `msg.sender`), runs the `onCreateMarket` hook, deploys from stored initcode, calls `archController.registerMarket(market)`, and records the factory-side mappings. The richest single event is:

```
MarketDeployed(hooksTemplate, market, name, symbol, asset, maxTotalSupply,
               annualInterestBips, delinquencyFeeBips, withdrawalBatchDuration,
               reserveRatioBips, delinquencyGracePeriod, hooks)
```

So "all markets for borrower X" is either: enumerate ArchController markets and filter on `market.borrower() == X`, or walk the factory maps. **For a claim tool, the inverse (market → borrower) is what matters and is a single immutable read per market.**

## 3. Lender position on a market

A lender's stake is just their market-token balance, which rebases with interest:

- `market.balanceOf(lender)` → **normalized** balance = underlying assets currently owed to the lender (including accrued interest), in underlying-token decimals. This is the natural "amount owed / claim size."
- `market.scaledBalanceOf(lender)` → scaled balance (pre-scaleFactor); `normalized = scaled × scaleFactor` (ray math).

The lens packages this as `LenderAccountData` (`src/lens/LenderAccountData.sol`): `scaledBalance`, `normalizedBalance`, `underlyingBalance` (their wallet balance of the underlying), `underlyingApproval`, plus hooks/access fields (`isBlockedFromDeposits`, `isKnownLender`, role provider data).

## 4. Delinquency & penalty state

All economics live in one packed `MarketState` struct per market (`_state`, three storage slots; see `src/libraries/MarketState.sol`). Relevant fields:

- `isDelinquent` (bool), `timeDelinquent` (uint32 seconds — the "grace tracker"), `reserveRatioBips`, `annualInterestBips`, `scaleFactor`, `scaledTotalSupply`, `scaledPendingWithdrawals`, `accruedProtocolFees`, `normalizedUnclaimedWithdrawals`, `pendingWithdrawalExpiry`.
- Penalty parameters are immutables on the market: `delinquencyFeeBips`, `delinquencyGracePeriod`.

**Definition of delinquency** (`WildcatMarketBase._writeState`):

```
isDelinquent = liquidityRequired() > totalAssets()
```

`liquidityRequired()` (`MarketStateLib`) = reserveRatio × outstanding scaled supply + 100% of pending withdrawals + unclaimed withdrawals + accrued protocol fees, all normalized. `totalAssets()` is the underlying the market actually holds. `isDelinquent` is recomputed and persisted on **every state-mutating call**, so the *stored* value is only as fresh as the last interaction.

**Reading the live value:** `market.currentState()` returns a `MarketState` with interest/fees/delinquency replayed to `block.timestamp` *without writing* — use this (directly or via the lens) for an accurate read. `market.previousState()` returns the last-written state.

**Grace tracker / penalty timing** (`FeeMath.updateTimeDelinquentAndGetPenaltyTime`):

- While delinquent, `timeDelinquent` counts **up** by elapsed seconds; penalised seconds = elapsed − whatever grace remained.
- While not delinquent, `timeDelinquent` counts **down** toward zero; the penalty still applies for the portion still above `delinquencyGracePeriod`.

This makes the grace period **rolling** — curing delinquency does not instantly switch off the penalty; it switches off once `timeDelinquent` falls back below `delinquencyGracePeriod`. Therefore "penalty APR is active" is best computed as: `timeDelinquent > delinquencyGracePeriod` (using the live `currentState`).

**Penalty APR application** (`FeeMath.updateScaleFactorAndFees`): each accrual computes base interest, protocol fee, and — when there are penalised seconds — a delinquency fee from `delinquencyFeeBips`. Base + delinquency feed `scaleFactor` growth (accruing to lenders via market-token rebasing); the protocol fee is separate and the penalty never inflates it.

## 5. The MarketLens — one-call reads

`src/lens/MarketLens.sol` + `MarketData.sol` give an off-chain reader everything in a single `eth_call` per market, computed from the *live* `currentState()`:

- `getMarketData(address market) → MarketData` and `getMarketsData(address[] markets) → MarketData[]`.
- `MarketData` includes: `borrower`, `hooksFactory`, token metadata, `isClosed`, `reserveRatioBips`, `annualInterestBips`, `delinquencyFeeBips`, `delinquencyGracePeriod`, `scaleFactor`, `totalSupply`, `totalAssets`, `isDelinquent`, `timeDelinquent`, `coverageLiquidity` (= `liquidityRequired()`), withdrawal-batch data, and more.
- `getMarketDataWithLenderStatus(lender, market)` and `getLenderAccountQueries(...)` fold in `LenderAccountData` (the lender's `normalizedBalance`, etc.) per market.

For a claim tool, the lens collapses "is this market delinquent, who's the borrower, what does this lender hold" into one read per market.

## 6. Observability surface for an indexer

| Need | On-chain source |
|---|---|
| Enumerate all markets | `WildcatArchController.getRegisteredMarkets()` + `MarketAdded` / `MarketRemoved` events |
| Enumerate borrowers | `getRegisteredBorrowers()` + `BorrowerAdded` / `BorrowerRemoved` |
| Market → borrower | `market.borrower()` (immutable) or `MarketData.borrower` |
| Borrower → markets | `HooksFactory` borrower→instance→market maps, or filter markets by `borrower()` |
| Market terms (rates, grace, reserve) | `MarketDeployed` event, or `MarketData` |
| Live delinquency/penalty | `market.currentState()` / `MarketData.isDelinquent`, `timeDelinquent`, `coverageLiquidity` |
| Historical accrual & penalty onset | per-market `_InterestAndFeesAccrued(fromTs, toTs, scaleFactor, baseInterestRay, delinquencyFeeRay, protocolFee)` |
| Lender claim size | `market.balanceOf(lender)` / `LenderAccountData.normalizedBalance` |

## 7. Adjacent: sanctions layer

`WildcatSanctionsSentinel` + per-lender escrow contracts (via the Chainalysis oracle) sit beside the markets. A sanctioned lender's position can be excised into an escrow contract; interest stops accruing on transfer. A claim tool that derives "amount owed" should be aware that a sanctioned lender's claim may have been moved to an escrow address rather than remaining as a market-token balance.

## Net picture

The ArchController is the enumerable source of truth for markets/borrowers/factories. Borrower attribution is a one-read immutable per market. Per-market financial and delinquency state is read live through `currentState()` / `MarketLens`, with `_InterestAndFeesAccrued` events for history. Everything a lender-claim tool needs — *which markets are delinquent, who the borrower is, and what each lender is owed* — is available from `WildcatArchController` + `MarketLens` with no privileged access.

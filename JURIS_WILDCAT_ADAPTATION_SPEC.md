# Adapting Juris → Wildcat Lender Claim-Intake — Technical Spec

## 0. Goal & scope

Fork `juris.ndx.fi` into a claim-intake tool for **lenders in distressed Wildcat V2 markets**. A lender connects a wallet; the service determines on-chain whether that address is a lender in any **delinquent or penalty-active** Wildcat market and how much it is owed; if eligible, the lender signs a claim form (contact, location, consent to litigate / speak to law enforcement) which is persisted to LevelDB and mirrored to a Google Sheet for the legal/coordination team.

Decisions locked for this spec:

- **Purpose:** lender claim-intake (direct analog of Juris).
- **Eligibility:** address is a lender in a market that is currently delinquent *or* has the penalty APR active. Computed on-chain.
- **Backend:** keep the Juris stack (Express + EIP-712/personal_sign verification + LevelDB + Google Sheets). Swap only the chain-reading module. Minimal, surgical retarget.

Companion reading: `WILDCAT_PROTOCOL_ARCHITECTURE.md` (the on-chain surface this spec consumes) and `EXPLAINER.md` (the original Juris design).

## 1. Conceptual mapping (Juris → Wildcat)

| Juris concept | Wildcat equivalent |
|---|---|
| Affected index token (hard-coded list of 6) | Registered Wildcat market (dynamic, enumerated from ArchController) |
| `lossPerToken` constant | Per-lender `normalizedBalance` (underlying owed), read live |
| Held balance at exploit block `13417849` | Lender market-token balance, read at a chosen snapshot or live |
| "Affected" = nonzero balance in a listed token | "Eligible" = lender in a market that is delinquent / penalty-active |
| `MultiTokenStaking.userInfo` staked add-on | Withdrawal-batch / escrow nuances (see §6.4) |
| `affectedTokens(account)` | `eligibleClaims(account)` (new) |
| Single mainnet via Alchemy, fixed block | Configurable network + RPC; live `currentState()` reads |
| `estimatedLoss` = Σ balance×lossPerToken | `amountOwed` = Σ `normalizedBalance` across eligible markets |

The structural skeleton — verify signature → recover address → confirm on-chain eligibility → persist claim — is **identical**. Only the "who's affected and by how much" computation is replaced.

## 2. Files: keep / replace / add

```
src/
  index.ts            KEEP, minor edits  (endpoints renamed; eligibility recheck on submit)
  utils.ts            EDIT               (form schema + EIP-712 types: incident/claim fields)
  database.ts         KEEP (mostly)      (keyed by lender address; add per-incident namespacing if needed)
  simple-level.ts     KEEP unchanged
  sheets.ts           EDIT               (header/row schema for lender claims)
  httpRedirect.ts     KEEP unchanged

  balance-check.ts    REPLACE  ───────►  wildcat/eligibility.ts   (eligibleClaims, EligibleClaim type)
  typechain/          REPLACE  ───────►  wildcat/chain.ts         (ArchController + MarketLens reads)
  abi/                REPLACE  ───────►  abi/WildcatArchController.json, abi/MarketLens.json, abi/IERC20.json

  wildcat/config.ts   ADD                (addresses, network, snapshot policy)
```

Removed entirely: `MultiTokenStaking.json`, the six-token list, `BLOCK_NUMBER = 13417849`, and the import-time `affectedTokens(...).then(console.log)` test call.

## 3. New chain layer

### 3.1 `wildcat/config.ts`

```ts
export interface WildcatConfig {
  network: string;                 // 'mainnet' | 'sepolia'
  rpcUrl: string;                  // from env (Alchemy/Infura/own node)
  archController: string;          // 0xfEB516d9D946dD487A9346F6fee11f40C6945eE4 (mainnet)
  marketLens: string;              // confirm from live deployment
  snapshotBlock?: number;          // optional: pin reads to a block (see §5)
  minOwedWei?: bigint;             // dust threshold to ignore (default 0)
}
```

Load from `.env`: `RPC_URL`, `WILDCAT_NETWORK`, `ARCH_CONTROLLER`, `MARKET_LENS`, optional `SNAPSHOT_BLOCK`. No addresses hard-coded in source — Juris's hard-coded constants were a maintenance trap; this version is config-driven so the same code serves mainnet, Sepolia, or a future incident.

### 3.2 `wildcat/chain.ts` — provider + reads

Two contracts only:

- **`WildcatArchController`** — `getRegisteredMarketsCount()`, `getRegisteredMarkets(start, end)` (paginate; do not assume the set is small).
- **`MarketLens`** — `getMarketDataWithLenderStatus(lender, market)` returns `{ market: MarketData, lenderStatus: LenderAccountData }` in one call. Prefer this over hand-rolling `market.currentState()` + `balanceOf` — the lens already replays accrual to `block.timestamp` and exposes `isDelinquent`, `timeDelinquent`, `delinquencyGracePeriod`, `borrower`, and `lenderStatus.normalizedBalance` together.

```ts
import { Contract, JsonRpcProvider } from 'ethers';

const provider = new JsonRpcProvider(cfg.rpcUrl);
const arch = new Contract(cfg.archController, ARCH_ABI, provider);
const lens = new Contract(cfg.marketLens, LENS_ABI, provider);

export async function getAllMarkets(): Promise<string[]> {
  const count: bigint = await arch.getRegisteredMarketsCount({ blockTag });
  const out: string[] = [];
  const PAGE = 100n;
  for (let i = 0n; i < count; i += PAGE) {
    out.push(...await arch.getRegisteredMarkets(i, i + PAGE, { blockTag }));
  }
  return out;
}
```

`blockTag` = `cfg.snapshotBlock ?? 'latest'`. (Note: lens reads against a historical `blockTag` only work if the node is an archive node — see §5.)

Performance: with N markets and a per-lender query, a naive loop is N `eth_call`s per lookup. Mitigate with (a) a cached, periodically-refreshed list of *currently distressed* markets — most markets are healthy, so filter the market set once via `getMarketsData` and only run the per-lender lens call against distressed ones; (b) Multicall3 aggregation; (c) a short-TTL in-memory cache of `MarketData` keyed by market address. See §7.

### 3.3 `wildcat/eligibility.ts` — the core check

```ts
export type EligibleClaim = {
  market: string;
  borrower: string;
  asset: string;
  assetSymbol: string;
  amountOwed: string;        // normalizedBalance, decimal string in asset units
  amountOwedWei: string;
  isDelinquent: boolean;
  penaltyActive: boolean;    // timeDelinquent > delinquencyGracePeriod
  timeDelinquent: number;
  delinquencyGracePeriod: number;
};

export async function eligibleClaims(account: string): Promise<EligibleClaim[]> {
  const distressed = await getDistressedMarkets();           // cached, see §7
  const results = await Promise.all(distressed.map(async (m) => {
    const { market, lenderStatus } = await lens.getMarketDataWithLenderStatus(account, m);
    const owed = BigInt(lenderStatus.normalizedBalance);
    if (owed <= (cfg.minOwedWei ?? 0n)) return undefined;
    const penaltyActive = BigInt(market.timeDelinquent) > BigInt(market.delinquencyGracePeriod);
    if (!market.isDelinquent && !penaltyActive) return undefined;
    return toEligibleClaim(m, market, lenderStatus, penaltyActive);
  }));
  return results.filter(Boolean) as EligibleClaim[];
}
```

Eligibility predicate (mirrors Juris's "nonzero affected balance"): **`normalizedBalance > threshold` AND (`isDelinquent` OR `timeDelinquent > delinquencyGracePeriod`).** `amountOwed` per market is the lender's `normalizedBalance`; total claim = Σ over eligible markets. This is the analog of Juris's `estimatedLoss`.

## 4. HTTP API changes (`index.ts`)

Keep the two-endpoint shape; rename and re-point:

- `POST /eligibility` (was `/affected-tokens`) — body `{ account }` → returns `EligibleClaim[]`. Frontend uses it to show "you have claims in N distressed markets totalling X" before requesting a signature.
- `POST /submit` — body `{ data, signature }`. Flow unchanged in structure:
  1. `getFormDataError(data)` — validate form.
  2. `verifySignature(data, signature)` → recover `address`.
  3. `eligibleClaims(address)` — **re-check on-chain**; reject if empty (the analog of Juris's "Account not affected"). This re-check on the server is essential: never trust a client-supplied eligibility/amount.
  4. `amountOwed = Σ claim.amountOwed`; build the account record (now including the per-market claim breakdown).
  5. `database.putAccount(account)` then `addAccount(account)` (sheet).

Fix the inherited bugs while here: `/submit` currently swallows DB/sheet errors and still returns 200, and `verifySignature` is checked with the always-truthy `if (!address.toLowerCase())`. Return a 5xx on persistence failure and validate the recovered address properly.

## 5. Snapshot / block policy (design decision)

Juris pinned every read to the exploit block, making losses immutable. Wildcat distress is **ongoing and live**, so there is no single canonical block. Options:

- **(A) Live reads at submission time (recommended default).** Read `currentState()`/lens at `latest`. Record `blockNumber` and `timestamp` of the read inside the stored claim so the figure is auditable. Pro: no archive node needed; reflects reality at claim time. Con: amount owed drifts with interest/penalty between view and submit — acceptable, just snapshot it into the record.
- **(B) Pinned incident block.** If the legal effort is tied to a specific event (e.g. a borrower default at block B), set `cfg.snapshotBlock = B` and read everything at `blockTag = B`. Requires an **archive node**. Produces Juris-style immutable figures. Best when "the claim" is defined as of a fixed moment.

Recommendation: default to (A), but make `snapshotBlock` a config switch so a specific incident can freeze to (B) without code changes. Always store the block number used in each claim record.

## 6. Form, signature, persistence schemas

### 6.1 `utils.ts` — `FormData` / `AccountData`

Keep the contact + location + consent fields (they're equally relevant to a lender claim). Extend `AccountData` with Wildcat claim context captured at submit time:

```ts
export type AccountData = FormData & {
  address: string;
  signature: string;
  network: string;
  snapshotBlock: number;
  totalAmountOwed: string;          // sum, decimal string
  claims: EligibleClaim[];          // per-market breakdown
};
```

### 6.2 EIP-712 / `personal_sign`

Keep both verification paths. Update the typed-data `types` and `toSignatureString`/`toTypedData` so the signed message commits to the claim context, not just contact info — so a signature can't be replayed against a different incident:

```
Data { Contact contactInfo; Location location; Options options; Claim claim; }
Claim { string network; uint256 snapshotBlock; string marketsHash; }   // keccak of sorted eligible market addrs
```

The server recomputes `marketsHash` from its own `eligibleClaims` result and rejects if it doesn't match the signed value. `verifyTypedData({}, types, ...)` with an empty domain is fine to carry over, but consider adding a proper EIP-712 domain (`name: "Wildcat Claims", version, chainId`) to bind signatures to a chain.

### 6.3 `sheets.ts` — header/row

Replace the token-loss columns with claim columns. New `headerRow`:

```
Country, State, City, Will speak to LEO?, Will litigate?,
Network, Snapshot Block, Total Owed (asset units), # Markets,
Market Addresses, Borrowers, Per-Market Owed,
Name, Email, Other Contact Info, Ethereum Address, Signature
```

`toRow` serializes `claims[]` into the `Market Addresses` / `Borrowers` / `Per-Market Owed` columns (e.g. newline- or semicolon-joined, parallel order). Upsert-by-address logic is unchanged.

### 6.4 Edge cases to handle in eligibility

- **Withdrawal batches:** a lender mid-withdrawal may hold less market-token balance than their true claim; `normalizedBalance` from the lens covers the still-held portion. If claims should include pending/expired withdrawal amounts, also read `LenderAccountQueryResult.withdrawalBatches` and add the lender's share. Decide with legal whether queued withdrawals count as "owed."
- **Sanctioned lenders / escrow:** a position excised to a `WildcatSanctionsEscrow` no longer shows as a market-token balance. If such lenders must be able to claim, additionally resolve the sentinel's escrow address for the lender/market and read its balance.
- **Closed markets:** `isClosed` markets aren't delinquent but may still owe lenders; confirm whether a closed-but-unpaid market is in scope.

## 7. Performance & operational notes

- **Distressed-market cache.** Maintain a background refresh (e.g. every N minutes) that calls `lens.getMarketsData(allMarkets)` and caches the subset where `isDelinquent || timeDelinquent > delinquencyGracePeriod`. `/eligibility` then only does per-lender lens calls against that small subset. Most markets are healthy, so this turns an O(all markets) lookup into O(distressed).
- **Multicall3.** Batch the per-market lens calls in one `eth_call` to cut latency and RPC usage.
- **Remove import-time side effects.** Unlike Juris (`connectSheet()` and a test `affectedTokens(...)` run on import), gate all network/sheet connections behind explicit init called from `index.ts` startup, so the module is testable and a missing RPC/sheet doesn't crash import.
- **Error handling.** `/submit` must surface DB/sheet write failures (non-200) rather than logging and returning success.
- **Secrets/config:** `.env` (`RPC_URL`, `ARCH_CONTROLLER`, `MARKET_LENS`, `WILDCAT_NETWORK`, optional `SNAPSHOT_BLOCK`) + `.google.json` (service account). Same gitignore posture as Juris.
- **Stack modernization (optional, out of scope here):** ethers v6 (this spec assumes v6 imports; if staying on v5, `JsonRpcProvider`/`BigInt` usages adjust accordingly).

## 8. Implementation plan (ordered)

1. Scaffold `wildcat/config.ts`; move all addresses to `.env`.
2. Add ABIs: `WildcatArchController`, `MarketLens`, `IERC20` (extract from `v2-protocol/out/` artifacts).
3. Build `wildcat/chain.ts`: provider, `getAllMarkets()`, lens wrappers.
4. Build `wildcat/eligibility.ts`: `eligibleClaims()` + `EligibleClaim`; distressed-market cache.
5. Rewire `index.ts`: rename endpoints, swap `affectedTokens` → `eligibleClaims`, fix signature/error bugs, add startup init.
6. Update `utils.ts` types + EIP-712/personal_sign payload (claim context + `marketsHash`).
7. Update `sheets.ts` header/row + `database.ts` record shape.
8. Delete `typechain/`, `abi/MultiTokenStaking.json`, old `balance-check.ts`.
9. Frontend: re-point `/affected-tokens`→`/eligibility`, update the signed payload and the "your claims" display. (Frontend source is not in the Juris repo — only `app-build/` — so this needs the React source or a rebuild.)

## 9. Test strategy

- **Unit:** `eligibleClaims` against mocked lens responses — healthy market (excluded), delinquent w/ balance (included), penalty-active-but-not-currently-delinquent (included via `timeDelinquent > grace`), zero balance (excluded), dust below threshold (excluded).
- **Signature:** round-trip EIP-712 and `personal_sign`; assert recovered address; assert `marketsHash` mismatch is rejected; assert replay across networks fails (domain `chainId`).
- **Integration (Sepolia fork):** point at the repo's Sepolia ArchController/MarketLens, deploy or use an existing delinquent market, assert end-to-end `/eligibility` and `/submit`.
- **Verification step:** before sign-off, diff stored claim amounts against an independent direct `market.balanceOf(lender)` read at the recorded block to confirm the lens-derived figures match.

## 10. Open questions for the team

1. Do queued/expired **withdrawals** and **closed-but-unpaid** markets count toward an eligible claim?
2. Must **sanctioned/escrowed** lenders be able to register (requires sentinel/escrow resolution)?
3. Is the claim defined **as of a fixed incident block** (archive node, option B) or **live at submission** (option A)?
4. One global intake, or **per-borrower / per-incident** scoping (affects DB namespacing, the sheet, and the signed `Claim` struct)?

# wildcat-claims

Lender claim-intake service for defaulted Wildcat V2 markets. A fork of `juris.ndx.fi`,
retargeted from the Indexed Finance exploit to live Wildcat protocol state.

A claim is one **lender** against one **market**. The lender finds the affected market via
its **borrower** (the borrower's markets are enumerated on-chain), connects the wallet they
lent with, and — if the market is in default and they still hold a position — signs a claim
form (contact, country, consent to participate in litigation). The server verifies the
signature and returns a copyable proof (the signed payload plus the verification details);
nothing is persisted yet (export/email is future work). This is a tool for **civil
breach-of-contract claims**.

See `../JURIS_WILDCAT_ADAPTATION_SPEC.md` for the original design and
`../WILDCAT_PROTOCOL_ARCHITECTURE.md` for the on-chain surface this reads.

## How it works

- **Discovery** — `WildcatArchController.getRegisteredMarkets()` enumerates every market;
  the borrower's markets are those whose immutable `market.borrower()` matches. Each market
  carries a `name`, shown for selection.
- **Default gate** — a market is "in default" when, read live, its grace tracker has run a
  buffer past the grace period: `timeDelinquent >= delinquencyGracePeriod + DEFAULT_BUFFER_DAYS`
  (default 90 days).
- **Eligibility** — for the selected market, the lender's owed amount is their held balance
  (`MarketLensV2.getLenderAccountData(...).normalizedBalance`, or `market.balanceOf` in
  direct mode) plus, when enabled, their share of queued/expired withdrawal batches
  (`MarketLensV2` `normalizedAmountOwed`). Eligible = market in default **and** owed non-dust.
  All markets are assumed to be Wildcat V2.
- **Claim** — an EIP-712 / personal_sign signature commits to `{ network, market }`, so it
  can't be replayed to another market or chain. The server re-checks default + position live
  before persisting.

## Endpoints

- `GET /config` — network, chainId, default-buffer days, optional pre-filled borrower, EIP-712 domain.
- `POST /markets` — `{ borrower }` → that borrower's markets with names + live `inDefault`.
- `POST /eligibility` — `{ account, market }` → owed amount, default status, and the claim context to sign.
- `POST /submit` — `{ data: { form, claim }, signature }` → re-verifies and persists.

## Layout

```
src/
  index.ts              Express server: /config, /markets, /eligibility, /submit, /health
  wildcat/
    config.ts           network + addresses + DEFAULT_BUFFER_DAYS + optional BORROWER_ADDRESS
    abis.ts             ABI fragments (ArchController, market, ERC20, MarketLens)
    chain.ts            market enumeration, borrower filter, live state, lender reads
    eligibility.ts      default gate + getBorrowerMarkets() + eligibleClaim()
  utils.ts              form validation (country-level) + signature + EIP-712 types
  (no persistence yet — /submit verifies and returns a copyable proof; export/email is future work)
app-build/
  index.html            self-contained frontend (ethers + country-state-city via CDN)
test/
  eligibility.test.ts   default gate, owed math, borrower discovery (mocked chain)
  signature.test.ts     EIP-712 + personal_sign round-trips, market/chain binding
```

## Setup

```bash
npm install
cp .env.example .env      # set RPC_URL; optionally BORROWER_ADDRESS, DEFAULT_BUFFER_DAYS
# (no external sink: a successful submit returns a copyable signed-claim proof)
npm run typecheck
npm test
npm run dev               # ts-node, http on :3001 (serves app-build/)
```

Build & run:

```bash
npm run build && npm start
```

## Mainnet addresses (baked into `src/wildcat/config.ts`)

| Contract | Address |
|---|---|
| WildcatArchController | `0xfEB516d9D946dD487A9346F6fee11f40C6945eE4` |
| MarketLensV2 | `0xfDA5C5B96bb198D2fca1A01d759620B64Ae5afE7` |
| WildcatHooksFactory | `0xdd7dd3b5076cf89440d05585ff56d246386207be` |
| WildcatSanctionsSentinel | `0x437e0551892C2C9b06d3fFd248fe60572e08CD1A` |

## Open items

- **ABIs are verified against the deployed contracts.** Every fragment this service calls
  (WildcatArchController, the V2 market, and MarketLensV2) was cross-checked by selector +
  type against the on-chain ABIs. Note the deployed V2 `currentState()` has 13 fields
  (no `protocolFeeBips`) — the SDK typechain's `MarketStateV2Struct` is wrong; the on-chain
  shape is used here. What remains unconfirmed is live *data* behaviour, not the ABIs.
- **V2 only** — assumes V2 markets (per Wildcat). V1 markets would need the V1 lens and
  market wrappers.
- **Default definition** is the interim `grace + 90 days` rule, read live — no historical
  pinning. Adjust via `DEFAULT_BUFFER_DAYS`.
- **Sanctioned/escrowed lenders** are not resolved: a position moved to a sanctions escrow
  won't show as a balance and won't be counted.
- Sanctioned lenders aside, no rate-limiting / abuse protection on the public endpoints yet,
  and the CDN frontend deps should be self-hosted for production.

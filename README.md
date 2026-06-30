# Wildcat Juris

Lender claim-intake tool for defaulted **Wildcat V2** markets. A fork of `juris.ndx.fi`,
retargeted from the Indexed Finance exploit to live Wildcat protocol state.

A claim is one **lender** against one **market**. The lender finds the affected market via
its **borrower** (the borrower's markets are enumerated on-chain), connects the wallet they
lent with, and — if they still hold a position in it — signs a short claim form (contact +
country, confirming they're an impacted lender). The server verifies the signature and returns
a copyable proof (the signed payload plus the verification details); nothing is persisted yet
(export/email is future work).

The lender submits this proof to the **Wildcat Foundation** as evidence that they are an
impacted lender, in order to receive the (non-public) borrower information needed to pursue a
**civil breach-of-contract claim**.

## Repo layout

```
.
  README.md                         this file
  DEPLOY_VERCEL.md                  how to deploy on Vercel
  JURIS_WILDCAT_ADAPTATION_SPEC.md  the adaptation spec (Juris → Wildcat)
  WILDCAT_PROTOCOL_ARCHITECTURE.md  the on-chain surface this reads
  EXPLAINER.md                      the original Juris design
  wildcat-claims/                   the service — Express API + static frontend
    src/
      index.ts                      Express server: /config, /markets, /eligibility, /submit, /health
      wildcat/
        config.ts                   network + addresses + DEFAULT_BUFFER_DAYS + optional BORROWER_ADDRESS
        abis.ts                     ABI fragments (ArchController, V2 market, ERC20, MarketLensV2)
        chain.ts                    market enumeration, borrower filter, live state, lender reads
        eligibility.ts              getBorrowerMarkets() + eligibleClaim() (holdings gate)
      utils.ts                      form validation (country-level) + signature + EIP-712 types
    app-build/index.html            self-contained frontend (ethers + country-state-city via CDN)
    test/                           eligibility (holdings gate, owed math, discovery) + signature round-trips
```

The application lives entirely under `wildcat-claims/`; the Markdown files at the root are
design docs.

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
  (`MarketLensV2` `normalizedAmountOwed`). **Eligible = non-zero holdings** (owed non-dust) —
  any lender with a position is an impacted lender; the market's default status is reported as
  context but does not gate eligibility. All markets are assumed to be Wildcat V2.
- **Proof** — an EIP-712 / personal_sign signature commits to
  `{ network, market, penalizedDays, amountOwedWei, asOfBlock }`: it binds the market, how
  much is owed, and the block the figures were read at, so anyone can replay that block on an
  archive node to confirm the data is real, and the signature can't be reused elsewhere. The
  server re-checks eligibility live, then returns a copyable proof (nothing is stored).

## Endpoints

- `GET /config` — network, chainId, default-buffer days, optional pre-filled borrower, EIP-712 domain, debug flag.
- `POST /markets` — `{ borrower }` → that borrower's markets with names + live `inDefault`.
- `POST /eligibility` — `{ account, market }` → owed amount, default status, and the claim context to sign.
- `POST /submit` — `{ data: { form, claim }, signature }` → re-verifies the signature + eligibility and returns a copyable proof.

## Setup

```bash
cd wildcat-claims
npm install
cp .env.example .env      # RPC_URL defaults to the Wildcat archive node; optionally set BORROWER_ADDRESS, DEFAULT_BUFFER_DAYS
npm run typecheck
npm test
npm run dev               # ts-node, http on :3001 (serves app-build/)
```

Build & run:

```bash
npm run build && npm start
```

No build step is needed to demo the UI without an RPC: `node scripts/demo-server.js` runs the
real eligibility + signature code against a mock chain.

## Deploy

The app runs on Vercel as a single serverless function (it serves both the page and the API).
See **[DEPLOY_VERCEL.md](DEPLOY_VERCEL.md)** for the full runbook — the key prerequisite is that
the deployed function can reach your `RPC_URL`, and `DEBUG_MODE` must stay off in production.

## Mainnet addresses (baked into `wildcat-claims/src/wildcat/config.ts`)

| Contract | Address |
|---|---|
| WildcatArchController | `0xfEB516d9D946dD487A9346F6fee11f40C6945eE4` |
| MarketLensV2 | `0xfDA5C5B96bb198D2fca1A01d759620B64Ae5afE7` |
| WildcatHooksFactory | `0xdd7dd3b5076cf89440d05585ff56d246386207be` |
| WildcatSanctionsSentinel | `0x437e0551892C2C9b06d3fFd248fe60572e08CD1A` |

## Notes & open items

- **ABIs are verified against the deployed contracts.** Every fragment this service calls
  (WildcatArchController, the V2 market, and MarketLensV2) was cross-checked by selector +
  type against the on-chain ABIs. Note the deployed V2 `currentState()` has 13 fields
  (no `protocolFeeBips`) — the SDK typechain's `MarketStateV2Struct` is wrong; the on-chain
  shape is used here. What remains unconfirmed is live *data* behaviour, not the ABIs.
- **`DEBUG_MODE`** (testing only) assumes any lender holds ≥100 of the underlying, so the
  signing flow can be exercised without a real position. Signatures are still verified.
  **Never enable it in production** — the proof will (honestly) report the holdings were assumed.
- **V2 only** — assumes V2 markets (per Wildcat). V1 markets would need the V1 lens and
  market wrappers.
- **Default definition** is the interim `grace + 90 days` rule, read live — no historical
  pinning. Adjust via `DEFAULT_BUFFER_DAYS`.
- **Sanctioned/escrowed lenders** are not resolved: a position moved to a sanctions escrow
  won't show as a balance and won't be counted.
- No rate-limiting / abuse protection on the public endpoints yet, and the CDN frontend deps
  should be self-hosted for production.
```

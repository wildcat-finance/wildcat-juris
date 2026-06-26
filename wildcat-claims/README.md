# wildcat-claims

Lender claim-intake service for distressed Wildcat V2 markets. A fork of `juris.ndx.fi`,
retargeted from the Indexed Finance exploit to live Wildcat protocol state.

A lender connects a wallet; the service checks on-chain whether the address is a lender in
any **delinquent or penalty-active** Wildcat market and how much it is owed. If eligible, the
lender signs a claim form (contact, location, consent to litigate / speak to law enforcement)
which is persisted to LevelDB and mirrored to a Google Sheet.

See `../JURIS_WILDCAT_ADAPTATION_SPEC.md` for the full design and `../WILDCAT_PROTOCOL_ARCHITECTURE.md`
for the on-chain surface this reads.

## How it works

- **Discovery** — `WildcatArchController.getRegisteredMarkets()` enumerates every market.
- **Distress filter** — each market's live `currentState()` gives `isDelinquent` and
  `timeDelinquent`; a market is distressed if `isDelinquent || timeDelinquent > delinquencyGracePeriod`.
  The distressed subset is cached (TTL configurable) so per-lender lookups stay cheap.
- **Eligibility** — for each distressed market, `market.balanceOf(lender)` is the lender's
  claim (underlying owed, incl. accrued interest). Eligible if non-dust.
- **Attribution** — `market.borrower()` ties each market to its borrower.
- **Claim** — EIP-712 / personal_sign signature commits to the eligible market set
  (`marketsHash`) + network, so it can't be replayed. The server re-checks eligibility and
  the hash before persisting.

## Layout

```
src/
  index.ts              Express server: /eligibility, /submit, /health
  wildcat/
    config.ts           network + address config (mainnet defaults baked in)
    abis.ts             human-readable ABI fragments (ArchController, market, ERC20)
    chain.ts            provider, market enumeration, state/balance reads
    eligibility.ts      distressed-market cache + eligibleClaims()
  utils.ts              form validation + signature verification + marketsHash
  database.ts           per-network claim store
  simple-level.ts       JSON kv over LevelDB / memdown
  sheets.ts             Google Sheets mirror
  httpRedirect.ts       port-80 -> HTTPS redirect (prod)
test/
  eligibility.test.ts   unit tests (mocked chain)
```

## Setup

```bash
npm install
cp .env.example .env      # set RPC_URL (Alchemy/Infura/your node)
# optional: add .google.json { client_email, private_key, sheet_id } for sheet mirroring
npm run typecheck
npm test
npm run dev               # ts-node, http on :3001
```

Build & run:

```bash
npm run build && npm start
```

## Mainnet addresses (baked into `src/wildcat/config.ts`)

| Contract | Address |
|---|---|
| WildcatArchController | `0xfEB516d9D946dD487A9346F6fee11f40C6945eE4` |
| MarketLens | `0xfDA5C5B96bb198D2fca1A01d759620B64Ae5afE7` |
| WildcatHooksFactory | `0xdd7dd3b5076cf89440d05585ff56d246386207be` |
| WildcatSanctionsSentinel | `0x437e0551892C2C9b06d3fFd248fe60572e08CD1A` |

## Open items (carried from the spec)

- Whether queued/expired withdrawals and closed-but-unpaid markets count toward a claim.
- Whether sanctioned/escrowed lenders must be able to register (needs sentinel/escrow resolution).
- Live reads (default) vs. a pinned incident block (`SNAPSHOT_BLOCK`, archive node).
- Frontend: not included here (the original Juris repo only shipped a pre-built bundle).
- For batched reads at scale, swap the per-market calls in `chain.ts` for
  `MarketLens.getMarketDataWithLenderStatus` (copy the full ABI from the protocol `out/`).

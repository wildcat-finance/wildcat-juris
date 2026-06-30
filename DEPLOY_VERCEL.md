# Deploying Wildcat Juris to Vercel

A step-by-step guide to running the claim-intake tool on Vercel.

## What gets deployed

The app is an Express server that serves both the single-page frontend and the API
(`/config`, `/markets`, `/eligibility`, `/submit`, `/health`). On Vercel it runs as **one
serverless function**:

- `wildcat-claims/api/index.ts` exports the Express app (`createApp()` from `src/app.ts`).
- `wildcat-claims/vercel.json` rewrites every path to that function, and ships the frontend
  HTML alongside it (`includeFiles: "app-build/**"`).

So there's nothing to "build" beyond installing dependencies — the function is TypeScript
(Vercel transpiles it) and the frontend is a committed static file the function serves.

## RPC: the Wildcat archive node is integrated by default

The app defaults to the Wildcat mainnet archive node (`https://eth-main.hinterlight.net/`,
baked into `src/wildcat/config.ts`), so the hosted deployment works without setting `RPC_URL`.
You can still override it by setting `RPC_URL` in the Vercel environment.

The one thing to verify: the function runs in Vercel's cloud, so **that node must be reachable
from Vercel's egress**. If it's network-restricted, either allowlist Vercel or set `RPC_URL` to
a publicly-reachable archive endpoint. If the RPC isn't reachable, the page still loads but
`/markets` and `/eligibility` will time out.

## Prerequisites

- The repo pushed to GitHub (`wildcat-finance/wildcat-juris`).
- Access to the Wildcat Vercel team.
- The default RPC (Wildcat archive node) must be reachable from Vercel, or override `RPC_URL`.
  An archive node is only strictly needed if you pin reads with `SNAPSHOT_BLOCK`.

## Deploy

1. **Vercel → Add New → Project → Import Git Repository →** `wildcat-finance/wildcat-juris`.
2. **Root Directory:** set to `wildcat-claims` (the app lives in that subfolder, and
   `vercel.json` / `api/` are there). This is the most important setting.
3. **Framework Preset:** Other. Leave Build Command and Output Directory empty/default —
   Vercel installs dependencies and builds the function automatically.
4. **Environment Variables** (Settings → Environment Variables) — see the table below. None
   are strictly required (the RPC defaults to the Wildcat archive node); set `BORROWER_ADDRESS`
   if you want the field pre-filled, and **leave `DEBUG_MODE` unset (or `false`).**
5. **Deploy.** Every push to `master` redeploys production; pull requests get preview URLs.

After it's live, sanity-check:

```
curl https://<your-deployment>/health     # {"ok":true,"network":"mainnet"}
curl https://<your-deployment>/config      # network, chainId, defaultBufferDays, debug:false, …
```

Then open the site, enter the borrower address, connect a wallet, and run an eligibility check.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RPC_URL` | no | Wildcat archive node | Ethereum RPC the function calls. Defaults to `eth-main.hinterlight.net`; override if needed. Must be reachable from Vercel. |
| `WILDCAT_NETWORK` | no | `mainnet` | `mainnet` or `sepolia` (selects baked-in contract addresses + chainId). |
| `BORROWER_ADDRESS` | no | — | Pre-fills the borrower field on the page. |
| `DEFAULT_BUFFER_DAYS` | no | `90` | "In default" = `timeDelinquent ≥ grace + this many days`. |
| `INCLUDE_WITHDRAWALS` | no | `true` | Count queued/expired withdrawals toward owed. |
| `MIN_OWED_WEI` | no | `0` | Dust threshold below which a position is ignored. |
| `LENS_MODE` | no | `lens` | `lens` (MarketLensV2) or `direct` (`balanceOf`) for the held read. |
| `DEBUG_MODE` | no | `false` | **Keep off in production.** Fakes holdings + relaxes the default gate for testing. |
| `SNAPSHOT_BLOCK` | no | — | Pin all reads to a block (needs an archive node). Unset = live. |
| `MULTICALL3` | no | canonical | Multicall3 address; only override if your chain uses a non-standard one. |

`MODE` and `PORT` are only used by the local/self-host entrypoint (`src/index.ts`) and are
ignored on Vercel.

> **Never set `DEBUG_MODE=true` in production.** With it on, any lender is treated as holding
> ≥100 of the underlying and the in-default requirement is relaxed — the signed proof will
> (honestly) report that the holdings were assumed, which is not a real claim.

## How requests are routed

```
Browser → Vercel → vercel.json rewrite "/(.*)" → /api  → Express app (createApp)
                                                          ├─ GET  /            → serves the page (app-build/index.html)
                                                          ├─ GET  /config,/health
                                                          └─ POST /markets,/eligibility,/submit
```

The function reads the chain efficiently: `/markets` batches every market's `borrower()` into
a **single** `eth_call` via Multicall3, then fetches the matched markets' info + state in ~2
more — so a borrower lookup is a handful of calls regardless of how many markets exist. The
function's `maxDuration` is 30s (in `vercel.json`); raise it in the dashboard if your RPC is
slow. Note serverless instances don't share an in-memory cache between requests, so the first
call after a cold start does the full read.

## Custom domain

Settings → Domains → add e.g. `claims.wildcat.finance` and point DNS as Vercel instructs.
Nothing in the app hard-codes a domain (the old self-host HTTPS block in `src/index.ts` is for
running outside Vercel and isn't used here).

## Local development parity

The same app runs locally — no Vercel needed:

```
cd wildcat-claims
npm install
cp .env.example .env     # set RPC_URL (and BORROWER_ADDRESS etc.)
npm run dev              # http://localhost:3001
```

To click through the UI with no RPC at all, the mock harness serves real eligibility +
signature code against fake chain data:

```
node scripts/demo-server.js
```

## Troubleshooting

- **Page loads but `/markets` times out / 500s** — Vercel can't reach the RPC (the Wildcat
  archive node by default). Allowlist Vercel's egress on the node, or override `RPC_URL`.
- **403 / "Write access" on `git push`** — that's GitHub, not Vercel (token/SSO scope).
- **Push rejected: "Commits must have verified signatures"** — the org ruleset requires signed
  commits; sign them or relax the rule for the import (see repo notes).
- **Function cold-start is slow** — expected for the first request; subsequent calls are warm.
  Multicall already minimizes round-trips; a faster RPC helps most.
- **`Missing required env/config value: …`** in function logs — only happens on a non-default
  network (e.g. `sepolia` without `ARCH_CONTROLLER`); set the named contract-address env var.
- **Wrong addresses** — they're baked in per `WILDCAT_NETWORK`; override individually with
  `ARCH_CONTROLLER` / `MARKET_LENS` / `HOOKS_FACTORY` if a deployment moves.
```

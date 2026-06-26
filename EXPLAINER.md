# juris.ndx.fi — Technical Explainer

## What this is

`juris.ndx.fi` is a small Node/TypeScript web service built for **Indexed Finance (ndx.fi)** in the aftermath of the **October 2021 exploit** (the affected state is read at Ethereum block `13417849`). It is a **victim-registration / claim-intake tool**.

It lets a wallet holder who was exposed to the affected Indexed Finance index tokens:

1. Check whether their address was affected and how much they lost (computed on-chain at the exploit block).
2. Cryptographically prove ownership of that address by signing a form with their Ethereum wallet.
3. Submit contact details, location, and consent flags (willingness to talk to law enforcement / to join litigation) for a coordinated legal recovery effort.

Submissions are persisted to a local key/value database and mirrored into a Google Sheet that the legal/coordination team works from.

The name reflects the purpose: *juris* (legal) for *ndx.fi* — a jurisdiction/legal-claim collection front-end.

## Repository layout

```
juris.ndx.fi-master/
├── package.json          # deps; no build/start scripts — tsc + node directly
├── tsconfig.json         # CommonJS, ES5 target, outDir ./dist, baseUrl src
├── yarn.lock
├── .gitignore            # .env, .google.json, node_modules/, src/.db/  (secrets/data not committed)
├── app-build/            # pre-built React frontend (static), served in production
│   ├── index.html
│   └── static/js/*.chunk.js
└── src/
    ├── index.ts          # Express server + HTTP API (entry point)
    ├── balance-check.ts  # "was this address affected, and how much did it lose?"
    ├── typechain/        # ethers contract bindings + on-chain balance reads
    │   ├── index.ts      # provider, staking contract, getAffectedBalance()
    │   ├── IERC20.d.ts
    │   ├── MultiTokenStaking.d.ts
    │   └── commons.ts
    ├── abi/              # IERC20.json, MultiTokenStaking.json
    ├── utils.ts          # form validation + EIP-712 / personal_sign verification
    ├── database.ts       # account store API over SimpleLevel
    ├── simple-level.ts   # JSON-serializing wrapper around LevelDB (mem or disk)
    ├── sheets.ts         # Google Sheets mirror of submissions
    └── httpRedirect.ts   # port-80 → HTTPS redirect helper
```

## Architecture & data flow

The backend is a single Express app (`src/index.ts`) that both serves the static React frontend and exposes two JSON endpoints. The frontend (in `app-build/`) collects the form, asks the user's wallet to sign it, and posts to the backend.

```
Browser (React app in app-build/)
   │  POST /affected-tokens { account }
   ▼
Express (index.ts) ──► balance-check.affectedTokens(account)
   │                         └─► typechain.getAffectedBalance(token, account)
   │                                 ├─ IERC20.balanceOf(account)        @ block 13417849
   │                                 └─ MultiTokenStaking.userInfo(i, …) @ block 13417849   (Alchemy mainnet)
   │
   │  POST /submit { data, signature }
   ▼
Express (index.ts)
   ├─ utils.getFormDataError(data)          validate country/state/city, contact, consent
   ├─ utils.verifySignature(data, sig)      recover signer address (EIP-712 typed-data or personal_sign)
   ├─ balance-check.affectedTokens(addr)    re-check on-chain; reject if not affected
   ├─ database.putAccount(account)          persist to LevelDB
   └─ sheets.addAccount(account)            upsert row into Google Sheet
```

### Endpoints (`src/index.ts`)

- **`POST /affected-tokens`** — body `{ account }`. Returns the list of affected tokens for that address with per-token balance and estimated lost value. Used by the frontend to show "you were affected" before asking for a signature.
- **`POST /submit`** — body `{ data, signature }`. Validates the form, verifies the wallet signature to recover the signer's address, re-confirms on-chain that the address was actually affected (so people can't register losses they didn't have), computes total estimated loss, then writes to both LevelDB and the Google Sheet.

Serving: in production (`MODE=production`) it serves the static `app-build/` directory over HTTPS on port 443 using Let's Encrypt certs read from `/etc/letsencrypt/live/juris.ndx.fi/`, and runs a companion port-80 → HTTPS redirect server. In dev it serves `build/` over plain HTTP on port 3001.

### On-chain affected-balance logic (`balance-check.ts` + `typechain/index.ts`)

A hard-coded list of six affected market tokens (e.g. `DEFI5`, `CC10`, `FFF` and their `*-ETH` Sushi pairs) each carry a `lossPerToken` USD figure. For a given account, `getAffectedBalance` reads, **at the fixed exploit block `13417849`**:

- the ERC-20 `balanceOf(account)` for the token, plus
- any amount the account had staked in the `MultiTokenStaking` contract (`0xC46E…6382`), looked up by the token's index in `stakingTokensList` via `userInfo(poolId, account)`.

`lostValue = balance × lossPerToken`. Reads go through an **Alchemy** mainnet provider (`ALCHEMY_API_KEY` from `.env`). Pinning to a historical block is what makes the loss figure deterministic and tamper-proof — it reflects holdings at the moment of the exploit, not now.

### Signature verification (`utils.ts`)

Two signing schemes are supported so the frontend can fall back gracefully:

- **EIP-712 typed data** — structured `Data { Contact, Location, Options }` types, verified with `verifyTypedData`.
- **`personal_sign`** — when the signature string is prefixed `personal_sign_`, the form is rendered to a canonical multi-line string and verified with `verifyMessage`.

Either way the result is the **recovered Ethereum address**, which is treated as the user's identity. The form is also validated server-side: country/state/city are checked against the `country-state-city` dataset, contact info requires at least an email or "other" field, email format is regex-checked, and the user must accept terms and opt into at least one of "speak to law enforcement" / "litigate".

### Persistence

- **`simple-level.ts`** — a thin wrapper over `levelup`/`leveldown` (disk) or `memdown` (in-memory). Keys and values are `JSON.stringify`'d on write and parsed on read; missing keys return `null` instead of throwing. Includes a stream-based `copy()` for snapshotting a DB. The on-disk DB lives at `src/.db/` (gitignored).
- **`database.ts`** — domain API on top of it: `putAccount` (stores the account keyed by lowercased address and maintains an `addresses` index array), `getAccount`, `getAllAddresses`.
- **`sheets.ts`** — connects to a Google Sheet via a service account (`.google.json`), ensures the header row, and **upserts** the submission (updates the existing row matching the Ethereum address, otherwise appends). This is the human-facing output the coordination team reads.

## Build & run

The project has **no `build`/`start` npm scripts** — you compile with `tsc` and run the emitted JS with `node`.

```bash
yarn install          # or npm install
npx tsc               # emits CommonJS to ./dist
node dist/index.js    # run the server
```

**Build status:** verified — `tsc` compiles cleanly (exit 0, 9 JS files emitted). The only compile error out of the box is `Cannot find module '../.google.json'`, because that credentials file is intentionally gitignored. Supplying a `.google.json` (even a stub) makes the compile pass with zero errors.

**Required runtime config (not in the repo, by design):**

- `.env` with `ALCHEMY_API_KEY` (and `MODE=production` to enable HTTPS mode).
- `.google.json` with `{ private_key, client_email, sheet_id }` for the Google Sheets service account.
- In production, Let's Encrypt certs at `/etc/letsencrypt/live/juris.ndx.fi/`.

A couple of modules run side-effecting code on import that assumes config is present — `sheets.ts` calls `connectSheet()` at module load, and `balance-check.ts`/`typechain` instantiate the Alchemy provider on load and even fire a test `affectedTokens(...)` call. Worth tidying when adapting (see below).

## Observations & notes for adapting to Wildcat

Things that are exploit-specific and will need to change for a Wildcat version:

- **Hard-coded incident parameters** live in `balance-check.ts` (token list + `lossPerToken`) and `typechain/index.ts` (`BLOCK_NUMBER = 13417849`, `MultiTokenStaking` address, `stakingTokensList`). These encode *the Indexed Finance exploit specifically*. For Wildcat, the affected-balance logic is likely quite different (Wildcat's markets, lenders/borrowers, the relevant contracts and the snapshot block all change), so `balance-check.ts` + `typechain/` is the main domain rewrite.
- **The form schema** (`utils.ts` types + `sheets.ts` `headerRow`) and the EIP-712 type definitions are tightly coupled — any field change must be made in the form, the typed-data `types`, `toTypedData`, `toSignatureString`, the sheet header, and `toRow` together.
- **The frontend is pre-built only** (`app-build/`); there's no frontend source in this repo. Adapting the UI means sourcing the React app separately, or rebuilding it.
- **Operational hygiene to fix on adaptation:** the import-time side effects (auto-connecting to Sheets, the test `affectedTokens` call at the bottom of `balance-check.ts`) should be removed/guarded; error handling on `/submit` swallows DB/sheet failures (logs but returns 200); and secrets are read from JSON/`.env` in a way you'll likely want to standardize.

Overall it's a compact, single-purpose service: **prove you owned affected tokens at a fixed block via a wallet signature, then collect your claim into a sheet.** The reusable skeleton for Wildcat is the Express + signature-verification + LevelDB + Sheets pipeline; the on-chain "who was affected and by how much" piece is the part that's specific to the original incident.

# Wildcat Juris — Technical Explainer

## What this is

A Node/TypeScript service that lets a **lender in a Wildcat V2 market** produce a signed,
independently verifiable proof that they held a position in that market, for submission to the
**Wildcat Foundation** as impacted-lender eligibility evidence.

The flow a lender walks:

1. Enter a **borrower** address; the service discovers that borrower's markets on-chain and reports
   each one's delinquency state.
2. Pick a market and connect the wallet that lent to it. The service reads the position **pinned to
   one block** and returns the figures that will be attested.
3. Agree to the **Qualifying Lender undertaking** (confidentiality over the borrower's Identifying
   Particulars) and sign. The signature commits to the claim figures and to the SHA-256 of the
   undertaking text.
4. Download the proof as two JSON files, or one `.zip`.

Nothing is persisted. There is no database and no spreadsheet: the output is the proof itself,
which anyone holding it can re-verify against an archive node.

> **On the name.** This repository began as a fork of `juris.ndx.fi`, a claim-intake tool built for
> Indexed Finance after the October 2021 exploit. None of that codebase remains — the on-chain
> logic, the form, the storage layer and the frontend were all replaced when it was retargeted to
> Wildcat V2. The name is the only inheritance.

## Repository layout

```
wildcat-juris/
├── EXPLAINER.md                    # this file
├── DEPLOY_VERCEL.md                # deployment runbook + env reference
├── SAFE_MULTISIG.md                # signing as a Safe (EIP-1271)
├── README.md, WILDCAT_PROTOCOL_ARCHITECTURE.md, JURIS_WILDCAT_ADAPTATION_SPEC.md
└── wildcat-claims/                 # the application
    ├── vercel.json                 # rewrites every path to api/index.ts
    ├── api/index.ts                # Vercel serverless entrypoint
    ├── app-build/index.html        # the entire frontend: one self-contained file
    ├── examples/                   # signed example proofs, pinned by test
    ├── scripts/
    │   ├── demo-server.js          # real code paths against a mock chain
    │   ├── generate-proof-examples.ts
    │   └── prove-safe-eip1271.js
    ├── src/
    │   ├── index.ts                # local/self-hosted entrypoint (TLS in MODE=production)
    │   ├── app.ts                  # createApp(): all routes
    │   ├── utils.ts                # the undertaking, EIP-712 types, form validation, recovery
    │   ├── verifyProof.ts          # the verifier, shared by app.ts and demo-server.js
    │   ├── debugSession.ts         # per-browser debug sessions
    │   ├── httpRedirect.ts         # port 80 → HTTPS
    │   └── wildcat/
    │       ├── config.ts           # env → WildcatConfig, deployment addresses
    │       ├── abis.ts             # ArchController, market, MarketLensV2, Multicall3, ERC-20
    │       ├── chain.ts            # all RPC access, batched via Multicall3
    │       └── eligibility.ts      # market discovery + the claim/verify derivations
    └── test/                       # vitest
```

## Architecture & data flow

One Express app serves both the single-page frontend and the JSON API. On Vercel it runs as a
single serverless function; locally `src/index.ts` listens directly.

```
Browser (app-build/index.html — one file, no build step)
   │  GET  /config                    domain, chainId, undertaking text + digest, debug flag
   │  POST /markets    { borrower }
   ▼
app.ts ──► Eligibility.getBorrowerMarkets(borrower)
   │          ├─ Chain.getAllMarkets()            ArchController registry
   │          ├─ Chain.readBorrowers(markets)      one Multicall3 eth_call
   │          └─ Chain.readMarketsInfoAndState()   one more, for the matches
   │
   │  POST /eligibility { account, market }
   ▼
app.ts ──► Eligibility.eligibleClaim(account, market, debug?)
   │          resolves asOfBlock FIRST, then pins every read to it
   │
   │  POST /submit { account, data, signature }
   ▼
app.ts ──► signature check: ECDSA recovery, or EIP-1271 for a contract wallet
   │       ──► Eligibility.eligibleClaim() again, server-side — the client is never trusted
   │       ──► returns a receipt; nothing is stored
   │
   │  POST /verify { signed, proof }
   ▼
verifyProof.ts ──► four layers (below)
```

### Routes (`src/app.ts`)

| route | purpose |
|---|---|
| `GET /health` | liveness. `?deep=1` also probes a header read and a state read separately |
| `GET /config` | what the page needs to render and to build identical typed data |
| `POST /markets` | a borrower's markets, with live delinquency state |
| `POST /eligibility` | one lender against one market; returns the claim context to sign |
| `POST /submit` | verify signature, re-check eligibility live, return the proof |
| `POST /verify` | re-verify a produced proof (see below) |
| `POST /debug/session` | open/close a debug session; 404s when `DEBUG_KEY` is unset |
| `GET /manifest.json`, `GET /icon.svg` | Safe App manifest, so a Safe can load this as a Custom App |
| `GET *` | the frontend |

## Eligibility (`src/wildcat/eligibility.ts`)

`eligibleClaim` resolves `asOfBlock` **before** reading anything and pins every read to it. Reading
at `latest` while stamping a separately-fetched block number would let the figures come from a
different block than the signature commits to, so an honest lender's proof would fail archive
replay — interest accrues per second, and held/withdrawal amounts could straddle a
`queueWithdrawal`.

Eligibility turns on **holdings alone**: a non-zero position makes you an impacted lender. Default
status (`inDefault`, `penalizedDays`) is derived and reported as context, but does not gate. That
matters for the verifier — see layer 4.

`penalizedDays` is whole days the penalty APR has been active, i.e. `timeDelinquent` beyond
`delinquencyGracePeriod`. "In default" is the interim rule `timeDelinquent >= grace +
defaultBufferSec` (90 days by default, `DEFAULT_BUFFER_DAYS`), read live.

## What gets signed (`src/utils.ts`)

EIP-712 typed data: `Data { Contact, Location, Options, Undertaking, Claim }`, where `Claim` is
`{ network, market, penalizedDays, amountOwedWei, asOfBlock }`.

The **Qualifying Lender undertaking** and its definition list are constants here, joined into one
canonical document whose SHA-256 (`QUALIFYING_LENDER_AGREEMENT_SHA256`) is what travels in the
signature — `Undertaking { agreed, sha256 }`. The wallet prompt therefore stays short while the
signature still binds the exact wording, which is published (rendered on the page and served by
`GET /config`) so any verifier can recompute the digest. Editing that text by a single character
changes the digest and invalidates every previously issued proof; `examples/` is pinned by test to
catch exactly that.

A `personal_sign` fallback exists server-side: when the signature is prefixed `personal_sign_`, the
form is rendered to a canonical multi-line string and verified with `verifyMessage`. The page itself
signs typed data only, but the format is supported end to end and shipped in `examples/`.

Smart-contract wallets have no key to recover from, so `/submit` asks the wallet whether it
authorized the digest (`isValidSignature`, EIP-1271). See SAFE_MULTISIG.md.

## The proof, as two JSON files

A completed submission produces two artifacts, shown on the receipt and downloadable together as
one `.zip` (built client-side with `fflate`; the archive also carries a `README.txt` naming each
file):

- **`signed-message.json`** — the exact EIP-712 payload that was signed: `{ domain, primaryType,
  types, message }`.
- **`proof.json`** — the detached `signature`, the `signer` address, and the server's receipt.

## The verifier (`src/verifyProof.ts`)

`POST /verify` takes `{ signed, proof }` — the two files, unzipped in the browser — and checks four
independent layers. It is stateless and trusts nothing the submitter says; every figure is
re-derived. It accepts either payload shape: typed data, or `personal_sign` text.

The implementation lives in its own module rather than inline in `app.ts` so that the real server
and `scripts/demo-server.js` run the *same* verifier. While each held its own copy they drifted,
and the verifier came to demand more of a proof than the issuer demands of a claim.

1. **Signature** — who signed. ECDSA recovery from the payload alone for an ordinary wallet
   (`recoverTypedSigner`, or `verifyMessage` for `personal_sign`); pure cryptography, no chain
   access. Where recovery yields nothing or a stranger, the named wallet is asked whether it
   authorized the payload's own digest under EIP-1271 — how a Safe signs.
2. **Binding** — an EIP-712 signature must be bound to this deployment's domain (`Wildcat Claims`
   v1) on the correct `chainId`, so a signature made for another app or chain cannot be replayed
   here. A `personal_sign` proof carries no domain, so this layer reports *not applicable* rather
   than a pass. A debug session expects its own domain (below).
3. **Undertaking** — the digest is recomputed from the published text and compared, and `agreed` is
   asserted. A proof predating the undertaking reports `present: false` — a limit on what could be
   established, not a forgery.
4. **On-chain replay** — `Eligibility.verifyClaimAtBlock(signer, market, asOfBlock)` re-reads the
   market and the signer's owed balance **pinned to the committed block** on an archive node, and
   confirms `penalizedDays` / `amountOwedWei` match what was signed. Because `currentState()`
   derives `timeDelinquent` from the block's own timestamp, an `eth_call` at `asOfBlock` reproduces
   the figures deterministically — anyone with an archive node reads back identical numbers.

   Default status is read back and **reported as context, not required**: eligibility turns on
   holdings alone, and a verifier demanding more than the issuer would reject proofs this service
   legitimately produced. This is also an **honest** read — the debug holdings fudge is never
   applied, so amounts compare byte for byte against the attestation.

The verdict: **`valid`** (all four confirmed), **`signature-valid`** (signer and binding good, but
something below is unproven — replay unreachable, or an undertaking that predates the commitment),
**`mismatch`** (authentic signature, but what it commits to does not hold up: the undertaking digest
is not the published one, or the figures no longer match chain), **`invalid`** (the signature did not
establish a signer, or is not bound to this deployment).

## Debug sessions (`src/debugSession.ts`)

`DEBUG_MODE` is process-wide, so it fakes eligibility for every visitor at once: local use only. For
a dry run against a live deployment — necessary because there may be no market in default, and no
wallet you control holding a position in one — `DEBUG_KEY` enables the same fudge scoped to **one
browser**.

Open a session by loading the normal page as `/#dbg=<DEBUG_KEY>`, end one with `/#dbg=off`. The
fragment never reaches a server, so the secret stays out of access logs, `Referer` headers and proxy
caches; the page posts it once, then strips it from the URL and history. The session is a stateless
HMAC cookie (`HttpOnly`, `SameSite=Strict`, `Secure` over https) expiring after 12 hours, with the
expiry covered by the MAC. Every handler asks per request, so a dry run never changes what anyone
else sees. With `DEBUG_KEY` unset, `/debug/session` 404s exactly like an unregistered path, and
answers a wrong key identically.

A dry run rests on faked holdings, so it must not be able to masquerade as evidence: claims signed
in a session use their own EIP-712 domain, `Wildcat Claims [DEBUG - NOT EVIDENCE]`, which the signer
sees in the wallet prompt, and the `personal_sign` path gets an equivalent banner line. A debug proof
therefore fails production verification structurally, rather than depending on a reader noticing a
flag.

## Chain access (`src/wildcat/chain.ts`)

Every read goes through Multicall3 `aggregate3` where it can, so market discovery is a handful of
`eth_call`s rather than O(markets). `getMarketInfo` / `getMarketState` / `readLenderHeld` /
`readWithdrawalsOwed` take an optional block tag (default: configured snapshot, else `latest`);
verification passes the historical `asOfBlock`.

Requests are bounded by `RPC_TIMEOUT_MS` (default 8000) — ethers' own default is 300s, ten times a
serverless function's budget. `isRpcTransportError` separates the endpoint failing from the contract
answering unusably, so a transport failure is reported rather than retried into a function timeout;
`isRpcAuthError` separates a gateway 401/403, which is configuration rather than a node fault. The
default RPC is the Wildcat gateway, which is authenticated (`RPC_BEARER_TOKEN`) and routes by chain
id.

## Frontend (`app-build/index.html`)

One self-contained file — no build step, no framework, ES modules from a CDN. It renders the
undertaking and its definitions from `GET /config`, recomputes the digest in the browser and refuses
to sign if it disagrees with the server, builds the typed data itself, and connects either an
injected wallet or a Safe (auto-detected when loaded as a Safe App).

The **"Foundation · verify a submitted proof"** section ships hidden: a lender mid-claim has nothing
to verify. It is revealed when a claim completes, immediately after the receipt, and at `/#verify` —
the Foundation arrives holding someone else's proof and never runs the claim flow, so gating purely
on completion would lock out the section's only intended user. It carries a plain-language account of
what is checked, how, and what each verdict means.

## Build & run

```bash
npm install
npm run build          # tsc -> dist/
npm start              # node dist/index.js   (PORT=3001, or 443 with MODE=production)
npm run dev            # ts-node src/index.ts
npm test               # vitest run
npm run typecheck      # tsc --noEmit
npm run examples       # regenerate examples/ (changes every digest — see above)
```

`scripts/demo-server.js` runs the real `Eligibility`, signing and verification code against a
**mock chain**, so the whole flow can be clicked through locally with no RPC:

```bash
npm run build && node scripts/demo-server.js    # :3001
```

Configuration is entirely environment-driven (`src/wildcat/config.ts`); `.env.example` lists every
variable and DEPLOY_VERCEL.md is the deployment reference.

## Notes & limits

- **V2 only.** V1 markets would need the V1 lens and market wrappers.
- **Default definition** is the interim `grace + 90 days` rule, read live — no historical
  reconstruction of when default was first reached.
- **Sanctioned/escrowed lenders** are not resolved: a position moved to a sanctions escrow is not
  attributed back to the lender.
- **The frontend carries its own copy of the undertaking text**, so the page and the server can
  drift. `test/undertaking.test.ts` pins them together, since a single character of drift would
  invalidate every signature the page produces.

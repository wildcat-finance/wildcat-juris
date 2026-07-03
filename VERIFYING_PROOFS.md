# Verifying a lender's claim proof

How the **Wildcat Foundation** confirms a proof it receives is genuine. A proof asserts two
independent facts, and each is checked a different way:

1. **Authenticity** — the wallet named in the proof signed *exactly* this claim (market, amount
   owed, penalized days, block). Pure cryptography; no chain needed for an EOA.
2. **On-chain truth** — the committed figures actually matched chain state at `asOfBlock`. This
   is what the archive node is for: the reads are replayed at that block.

Both checks are run for you by the tool below — the same code the intake server uses, so
verification is identical to how a submission was checked. **Verification always runs with
`DEBUG_MODE` forced off**, so it is meaningful even against a debug deployment: a debug proof
will authenticate but fail the on-chain check (its amount was assumed, not read).

## What the lender sends you

The receipt screen produces a **Verification bundle** — one self-contained blob:

```json
{ "payload": { "domain": …, "types": …, "message": … },
  "proof":   { "signer": "0x…", "signature": "0x…", "serverResponse": { … } } }
```

`payload` is the exact typed data that was signed; `proof` carries the signature and the
address. That's everything verification needs.

## Option A — in the app (no setup)

On any deployment, open **“Verify a proof”** at the bottom of the page, paste the bundle, and
click **Verify**. It calls `POST /verify` (which uses the server's archive node) and shows:

- **Signature authenticity** — `PASS`/`FAIL`, and the method (`eip712`, `personal_sign`, or
  `eip1271` for a Safe / contract wallet, checked on-chain at `asOfBlock`).
- **On-chain figures** — the amount owed and penalized days re-read at `asOfBlock`, each
  compared to what the proof committed.
- An overall **VERIFIED / NOT VERIFIED**, plus a warning if the proof was produced in debug mode.

> Use the production (**`DEBUG_MODE=false`**) deployment for real claims — a debug-generated
> proof will show `⚠ DEBUG` and fail the on-chain reconciliation by design.

## Option B — on the command line

Runs the identical checks locally against the Juris archive node:

```bash
cd wildcat-claims
npm install
# RPC_URL defaults to the Wildcat/Juris mainnet archive node baked into config.ts.
npm run verify -- bundle.json
# or pass the two receipt boxes as separate files:
npm run verify -- signed-payload.json proof.json
```

For a sepolia claim, also set `WILDCAT_NETWORK=sepolia` (and an appropriate `RPC_URL`). Exit
code is `0` when fully verified, `1` when not, `2` on bad input / network mismatch.

## What each result means

| Signature | On-chain | Meaning |
|---|---|---|
| PASS | PASS | Genuine: this wallet controls the position and the committed figures are real at `asOfBlock`. **Accept.** |
| PASS | FAIL | The wallet signed, but the figures don't match chain at that block — a debug proof, a tampered amount, or the position changed. **Do not accept as-is.** |
| FAIL | — | The signature doesn't authorize the stated address. **Reject.** |

## How it works under the hood

- **Signature.** For an EOA the signer is recovered from the EIP-712 typed data (or the
  `personal_sign` message) and compared to the claimed address. For a smart-contract wallet
  (e.g. a Safe) there is no key to recover, so the wallet's `isValidSignature(hash, sig)`
  (EIP-1271) is called **at `asOfBlock`** — Safe owners and thresholds, and EIP-7702 EOA
  delegations, change over time, so the block matters.
- **On-chain figures.** The eligibility reads (`MarketLensV2` balance / owed, and the market's
  delinquency grace tracker for penalized days) are replayed pinned to `asOfBlock`, then
  compared to `amountOwedWei` and `penalizedDays` in the claim. Because the claim commits the
  block, anyone with an archive node gets the same answer.

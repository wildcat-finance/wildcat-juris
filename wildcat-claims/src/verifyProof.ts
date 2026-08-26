import { getAddress, hashMessage, verifyMessage } from 'ethers';

import type { WildcatConfig } from './wildcat/config';
import type { Chain } from './wildcat/chain';
import type { Eligibility } from './wildcat/eligibility';
import {
  QUALIFYING_LENDER_AGREEMENT_SHA256,
  domainFor,
  parseSignatureLines,
  recoverTypedSigner,
  typedPayloadHash,
} from './utils';

/** What the verifier needs from its host: config, a chain to read, and the block-pinned replay. */
export interface VerifyDeps {
  cfg: WildcatConfig;
  chain: Pick<Chain, 'isContract' | 'isValidErc1271'>;
  eligibility: Pick<Eligibility, 'verifyClaimAtBlock'>;
}

/** 400 with a reason the caller can act on, or 200 with the layered verdict. */
export type VerifyOutcome =
  | { status: 400; error: string }
  | { status: 200; body: Record<string, unknown> };

/** A checksummed address, or null when the value is not one. */
function asAddress(v: unknown): string | null {
  try {
    return typeof v === 'string' ? getAddress(v) : null;
  } catch {
    return null;
  }
}

/**
 * Independently verify a produced proof (for the Wildcat Foundation). Four layers:
 *   1. Signature   — establish WHO signed: ECDSA recovery for an ordinary wallet, EIP-1271 for
 *                    a contract wallet, which has no key to recover from.
 *   2. Binding     — confirm the signature is bound to this deployment rather than another.
 *   3. Undertaking — recompute the Qualifying Lender digest and confirm the signer agreed to
 *                    the published wording, not merely to a boolean.
 *   4. On-chain    — replay the committed block on the archive node and confirm the lender was
 *                    owed the attested amount.
 *
 * Accepts either payload this tool produces, unzipped client-side:
 *   EIP-712        `{ signed: { domain, types, message },    proof: { signer, signature } }`
 *   personal_sign  `{ signed: { scheme, message: "<text>" }, proof: { signer, signature } }`
 *
 * Lives here rather than inline in app.ts so the real server and scripts/demo-server.js run
 * the SAME verifier: while each held its own copy they drifted, and the verifier ended up
 * demanding more of a proof than the issuer demands of a claim.
 */
export async function verifyProof(
  { cfg, chain, eligibility }: VerifyDeps,
  payload: unknown
): Promise<VerifyOutcome> {
  const { signed, proof } = (payload ?? {}) as {
    signed?: { domain?: any; types?: any; message?: any; scheme?: string; signature?: string };
    proof?: { signer?: string; signature?: string };
  };
  const signature = proof?.signature ?? signed?.signature;
  if (!signed || typeof signature !== 'string') {
    return { status: 400, error: 'Provide a signed message and a signature.' };
  }

  // ---- Normalise the two payload shapes -------------------------------------------------
  // Typed data carries the claim as an object; personal_sign carries the exact text signed.
  const typed = signed.message !== null && typeof signed.message === 'object';
  const text = typeof signed.message === 'string' ? signed.message : null;
  if (!typed && text === null) {
    return { status: 400, error: 'Signed message must be typed data or personal_sign text.' };
  }
  if (typed && (!signed.domain || !signed.types)) {
    return { status: 400, error: 'Typed data must come with its domain and types.' };
  }

  const fields = text === null ? null : parseSignatureLines(text);
  const claim = typed
    ? ((signed.message as any).claim ?? {})
    : {
        network: fields!.network,
        market: fields!.market,
        penalizedDays: fields!.penalizedDays,
        amountOwedWei: fields!.amountOwedWei,
        asOfBlock: fields!.asOfBlock,
      };

  // Absent entirely on a proof predating the undertaking. That is reported as a limit on what
  // could be established, not treated as a forgery.
  const undertaking: { agreed: unknown; sha256: unknown } | null = typed
    ? ((signed.message as any).undertaking ?? null)
    : fields!.undertakingSha256 === undefined
      ? null
      : { agreed: fields!.acceptUndertaking === 'true', sha256: fields!.undertakingSha256 };

  // ---- 1 · Signature: establish who signed ----------------------------------------------
  const claimedSigner = asAddress(proof?.signer);
  const bare = signature.replace('personal_sign_', '');
  let recovered: string | null = null;
  let recoverError: string | null = null;
  try {
    recovered = getAddress(
      text !== null
        ? verifyMessage(text, bare)
        : recoverTypedSigner(signed.domain, signed.types, signed.message, bare)
    );
  } catch (err: any) {
    recoverError = err.message;
  }

  // A Safe (or any contract wallet) authorizes a digest instead of producing a recoverable
  // signature, so recovery yields nothing, or a stranger. Ask the wallet itself. Only
  // meaningful against the address the proof names, so it needs one.
  let erc1271 = false;
  if (claimedSigner && recovered !== claimedSigner) {
    try {
      const digest =
        text !== null
          ? hashMessage(text)
          : typedPayloadHash(signed.domain, signed.types, signed.message);
      erc1271 =
        (await chain.isContract(claimedSigner)) &&
        (await chain.isValidErc1271(claimedSigner, digest, bare));
    } catch (err: any) {
      console.error('/verify erc1271:', err.message);
    }
  }

  let signer: string | null = null;
  let method: 'ecdsa' | 'erc1271' | null = null;
  if (recovered && (!claimedSigner || recovered === claimedSigner)) {
    signer = recovered;
    method = 'ecdsa';
  } else if (erc1271) {
    signer = claimedSigner;
    method = 'erc1271';
  }
  if (!signer) {
    return {
      status: 200,
      body: {
        signature: {
          valid: false,
          scheme: typed ? 'eip712' : 'personal_sign',
          recovered,
          claimedSigner,
          signerMatches: recovered && claimedSigner ? recovered === claimedSigner : null,
          error: recovered
            ? `Signature recovers to ${recovered}, not the named signer ${claimedSigner}, ` +
              'and that address did not authorize it under EIP-1271.'
            : 'Signature does not recover a signer: ' + recoverError,
        },
        overall: 'invalid',
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  // ---- 2 · Binding: is this bound to THIS deployment? -----------------------------------
  const network = typeof claim.network === 'string' ? claim.network : cfg.network;
  const networkMatches = network === cfg.network;
  const expectedDomain = domainFor(network);
  // personal_sign carries no domain: the text's own `network` line is the only binding it has,
  // so `matches` is null — absent, rather than contradicted.
  const domainMatches = typed
    ? signed.domain.name === expectedDomain.name &&
      String(signed.domain.version) === String(expectedDomain.version) &&
      Number(signed.domain.chainId) === Number(expectedDomain.chainId)
    : null;

  // ---- 3 · Undertaking: agreed to the published wording? --------------------------------
  const undertakingSha256 = typeof undertaking?.sha256 === 'string' ? undertaking.sha256 : null;
  const undertakingMatches =
    !!undertakingSha256 &&
    undertakingSha256.toLowerCase() === QUALIFYING_LENDER_AGREEMENT_SHA256.toLowerCase();
  const undertakingAgreed = undertaking?.agreed === true;
  const undertakingOk = undertaking !== null && undertakingAgreed && undertakingMatches;

  // ---- 4 · On-chain replay at the committed block ----------------------------------------
  const market = asAddress(claim.market);
  const asOfBlock = Number(claim.asOfBlock);
  let onChain: Record<string, unknown>;
  if (!networkMatches) {
    onChain = {
      checked: false,
      error: `Proof is for network "${network}"; this verifier serves "${cfg.network}".`,
    };
  } else if (market && Number.isInteger(asOfBlock) && asOfBlock > 0) {
    try {
      const live = await eligibility.verifyClaimAtBlock(signer, market, asOfBlock);
      onChain = {
        checked: true,
        asOfBlock,
        market,
        marketName: live.name,
        assetSymbol: live.assetSymbol,
        assetDecimals: live.assetDecimals,
        // Default status is context, not a gate: eligibility turns on holdings alone (see
        // Eligibility.eligibleClaim), and a verifier must not demand more than the issuer, or
        // it rejects proofs this service legitimately produced.
        inDefault: live.inDefault,
        penalizedDays: live.penalizedDays,
        amountOwedWei: live.amountOwedWei,
        daysMatch: Number(live.penalizedDays) === Number(claim.penalizedDays),
        amountMatches: live.amountOwedWei === String(claim.amountOwedWei),
        signerHeldPosition: live.eligible,
        withdrawalsError: live.withdrawalsError,
      };
    } catch (err: any) {
      console.error('/verify replay:', err.message);
      onChain = { checked: false, error: 'On-chain replay failed: ' + err.message };
    }
  } else {
    onChain = { checked: false, error: 'Signed message has no market/asOfBlock to replay.' };
  }

  // ---- Verdict ---------------------------------------------------------------------------
  const bindingOk = domainMatches !== false;
  const chainOk = onChain.checked
    ? Boolean(onChain.amountMatches) &&
      Boolean(onChain.daysMatch) &&
      Boolean(onChain.signerHeldPosition)
    : null;
  let overall: 'valid' | 'signature-valid' | 'mismatch' | 'invalid';
  if (!bindingOk) overall = 'invalid';
  else if (undertaking !== null && !undertakingOk) overall = 'mismatch';
  else if (chainOk === false) overall = 'mismatch';
  else if (chainOk === true && undertakingOk) overall = 'valid';
  else overall = 'signature-valid'; // signer and binding good; something below is unproven

  return {
    status: 200,
    body: {
      signature: {
        valid: true,
        scheme: typed ? 'eip712' : 'personal_sign',
        method,
        recovered: signer,
        claimedSigner,
        signerMatches: claimedSigner ? true : null,
      },
      domain: {
        applicable: typed,
        matches: domainMatches,
        networkMatches,
        expected: expectedDomain,
        provided: signed.domain ?? null,
      },
      undertaking: {
        present: undertaking !== null,
        agreed: undertaking === null ? null : undertakingAgreed,
        sha256: undertakingSha256,
        expected: QUALIFYING_LENDER_AGREEMENT_SHA256,
        matches: undertaking === null ? null : undertakingMatches,
      },
      claim: {
        network,
        market,
        penalizedDays: Number(claim.penalizedDays),
        amountOwedWei: String(claim.amountOwedWei),
        asOfBlock,
      },
      onChain,
      overall,
      verifiedAt: new Date().toISOString(),
    },
  };
}

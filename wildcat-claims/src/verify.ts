import { getAddress } from 'ethers';
import { WildcatConfig } from './wildcat/config';
import { Chain } from './wildcat/chain';
import { Eligibility } from './wildcat/eligibility';
import { verifySignature, claimDigest, type FormData, type SignedClaimContext } from './utils';

/**
 * Independent verification of a lender's claim proof — the flow the Wildcat Foundation runs on a
 * proof it receives. Shared by the CLI (scripts/verify-proof.ts) and the POST /verify endpoint so
 * both check a proof exactly the same way the server checks a submission.
 *
 * A proof asserts two independent facts, checked separately:
 *   1. Authenticity — the wallet named in the proof signed exactly this claim (EOA via signature
 *      recovery; a Safe / contract wallet via EIP-1271, evaluated at the claim's block).
 *   2. On-chain truth — the committed figures (amountOwedWei, penalizedDays) match chain state
 *      when the reads are replayed at `asOfBlock`. Requires an archive node.
 *
 * Verification always runs with DEBUG_MODE forced off, so it is meaningful even on a debug
 * deployment (a debug proof will authenticate but fail the on-chain check — its amount is assumed).
 */

/** The "Signed payload" box: EIP-712 typed data (domain + types + message). */
export interface SignedPayload {
  domain: unknown;
  types: unknown;
  primaryType?: string;
  message: any;
}

/** The "Signature & verification proof" box (only the fields verification needs). */
export interface ProofDoc {
  signer?: string;
  signature: string;
  serverResponse?: { lender?: string; debug?: boolean };
}

/** What a lender hands the Foundation: the signed payload plus the proof. */
export interface ProofBundle {
  payload: SignedPayload;
  proof: ProofDoc;
}

export interface VerifyReport {
  claimed: string;
  claim: SignedClaimContext;
  /** The proof self-reports it was produced in DEBUG mode (figures assumed, not real). */
  debug: boolean;
  signature: { valid: boolean; method: 'eip712' | 'personal_sign' | 'eip1271'; error?: string };
  onchain: {
    ok: boolean;
    read: boolean;
    error?: string;
    amountOwedWei: { claim: string; chain?: string; match: boolean };
    penalizedDays: { claim: number; chain?: number; match: boolean };
  };
  verified: boolean;
}

export class NetworkMismatchError extends Error {}

/** Rebuild the (form, claim) the signature covers from the typed-data `message`. */
export function reconstruct(message: any): { form: FormData; claim: SignedClaimContext } {
  const c = message.claim;
  return {
    form: {
      name: message.contactInfo.name,
      email: message.contactInfo.email,
      other: message.contactInfo.other,
      country: message.location.country,
      acceptTerms: message.options.acceptTerms,
    },
    claim: {
      network: c.network,
      market: getAddress(c.market),
      penalizedDays: Number(c.penalizedDays),
      amountOwedWei: String(c.amountOwedWei),
      asOfBlock: Number(c.asOfBlock),
    },
  };
}

export async function verifyProof(bundle: ProofBundle, baseCfg: WildcatConfig): Promise<VerifyReport> {
  const { form, claim } = reconstruct(bundle.payload.message);
  const signature = bundle.proof.signature;
  const claimed = getAddress(bundle.proof.serverResponse?.lender ?? bundle.proof.signer ?? '');
  const debug = !!bundle.proof.serverResponse?.debug;

  if (claim.network !== baseCfg.network) {
    throw new NetworkMismatchError(
      `proof is for '${claim.network}' but this server/run is '${baseCfg.network}'. ` +
        `Point it at a ${claim.network} deployment (WILDCAT_NETWORK=${claim.network}).`
    );
  }

  // Pin every read to the claim's block; force debug off so the check is real.
  const cfg: WildcatConfig = { ...baseCfg, snapshotBlock: claim.asOfBlock, debugMode: false };
  const chain = new Chain(cfg);
  const eligibility = new Eligibility(chain, cfg);

  // 1 · Authenticity — recover an EOA, or ask a contract wallet via EIP-1271 (both at asOfBlock).
  let sig: VerifyReport['signature'];
  try {
    if (await chain.isContract(claimed)) {
      sig = {
        method: 'eip1271',
        valid: await chain.isValidErc1271(claimed, claimDigest(form, claim, signature), signature),
      };
    } else {
      const method = signature.includes('personal_sign_') ? 'personal_sign' : 'eip712';
      sig = { method, valid: verifySignature(form, claim, signature).toLowerCase() === claimed.toLowerCase() };
    }
  } catch (err: any) {
    sig = { method: 'eip712', valid: false, error: err.message };
  }

  // 2 · On-chain truth — replay the eligibility reads at asOfBlock and compare the committed figures.
  const onchain: VerifyReport['onchain'] = {
    ok: false,
    read: false,
    amountOwedWei: { claim: claim.amountOwedWei, match: false },
    penalizedDays: { claim: claim.penalizedDays, match: false },
  };
  try {
    const live = await eligibility.eligibleClaim(claimed, claim.market);
    const amountMatch = live.amountOwedWei === claim.amountOwedWei;
    const daysMatch = live.penalizedDays === claim.penalizedDays;
    onchain.read = true;
    onchain.amountOwedWei = { claim: claim.amountOwedWei, chain: live.amountOwedWei, match: amountMatch };
    onchain.penalizedDays = { claim: claim.penalizedDays, chain: live.penalizedDays, match: daysMatch };
    onchain.ok = amountMatch && daysMatch;
  } catch (err: any) {
    onchain.error = err.message;
  }

  return { claimed, claim, debug, signature: sig, onchain, verified: sig.valid && onchain.ok };
}

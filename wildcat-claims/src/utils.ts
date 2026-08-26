import { createHash } from 'crypto';
import { Country } from 'country-state-city';
import {
  verifyMessage,
  verifyTypedData,
  getAddress,
  hashMessage,
  TypedDataEncoder,
  type TypedDataDomain,
} from 'ethers';

// ========================================================================== //
//                       Qualifying Lender undertaking                        //
// ========================================================================== //

/**
 * The confidentiality undertaking a *lender* gives over a borrower's Identifying Particulars.
 * The signer is a Qualifying Lender in a Market deployed by that borrower — not the party that
 * created it — dealing with the consequences of that Market's default, so the wording turns on
 * "the Market in respect of which that information was disclosed to you", never a Market of
 * the signer's own. Committed by digest (see QUALIFYING_LENDER_AGREEMENT_SHA256): do not
 * reword, reflow or re-punctuate it — any edit changes that digest and invalidates previously
 * issued proofs (regenerate `examples/` if it ever must change).
 */
export const QUALIFYING_LENDER_UNDERTAKING =
  'As a Qualifying Lender, you acknowledge and agree that by receiving any information ' +
  "relating to the Borrower's Identifying Particulars, you shall not use that information " +
  'for any purpose other than (i) in connection with the Market in respect of which that ' +
  'information was disclosed to you and (ii) to pursue any legitimate course of action ' +
  'arising therefrom.';

/**
 * The defined terms the undertaking turns on, spelled out so a signer is not agreeing to
 * language whose meaning lives somewhere they cannot see. Signed alongside the undertaking, and
 * subject to the same rule: any edit changes every digest. `Market` is deliberately absent — it
 * is evident on its face. Definitions daisy-chain: `Qualifying Lender` needs `Company` and
 * `default`; `Identifying Particulars` needs `borrower verification data`.
 */
export const QUALIFYING_LENDER_DEFINITION_LIST = [
  '"Qualifying Lender" means a person who (i) held a debt position (including market tokens) in ' +
    'the affected Market at the time of the relevant default, or (ii) has acquired such a debt ' +
    'position, in whole or in part, by transfer, whether before or after the default, and who in ' +
    'each case can demonstrate control of the relevant address(es) to the satisfaction of the Company.',
  '"Identifying Particulars" means the minimum information reasonably necessary for a lender to ' +
    'evaluate and, if it chooses, pursue its own rights and remedies against the borrower entity, ' +
    'including, but not limited to, the following: the legal name of the borrower entity; its ' +
    'registration number and jurisdiction of incorporation; its registered office address; and the ' +
    "name and role of a natural person authorised to accept service on the entity's behalf. For the " +
    'avoidance of doubt, such information shall include no other borrower verification data.',
  '"Company" means Wildcat Foundation.',
  '"default", in respect of a Market, means that the Market has entered a delinquent state and has ' +
    'incurred the penalty rate (as determined by the grace tracker) for a cumulative period of ' +
    'ninety (90) days; where a Loan Agreement is in place, that agreement governs instead.',
  '"borrower verification data" means the identity-verification data collected and retained by the ' +
    'Company and its identity-verification processor when a borrower is whitelisted, as described ' +
    'in the Privacy Policy.',
];

/**
 * The undertaking and its definitions as one canonical document: the exact bytes the SHA-256
 * committed in the signature is taken over. The signature carries only that digest, so the
 * wallet prompt stays readable; the text itself is published (rendered on the page, served by
 * GET /config, and constant here), so any verifier can recompute the digest and confirm what
 * was agreed. Change so much as a space and the digest — and every signature over it — changes.
 */
export const QUALIFYING_LENDER_AGREEMENT = [
  QUALIFYING_LENDER_UNDERTAKING,
  ...QUALIFYING_LENDER_DEFINITION_LIST,
].join('\n\n');

const sha256Hex = (s: string): string =>
  '0x' + createHash('sha256').update(s, 'utf8').digest('hex');

/** SHA-256 of QUALIFYING_LENDER_AGREEMENT, 0x-prefixed — the value bound into the signature. */
export const QUALIFYING_LENDER_AGREEMENT_SHA256 = sha256Hex(QUALIFYING_LENDER_AGREEMENT);

// ========================================================================== //
//                                   Types                                    //
// ========================================================================== //

export interface FormData {
  name: string;
  email: string;
  other: string;
  /** ISO country code (country-level only; no state/city). */
  country: string;
  acceptTerms: boolean;
  /**
   * Agreement to QUALIFYING_LENDER_UNDERTAKING and its definitions (confidentiality of the
   * Borrower's Identifying Particulars). One checkbox on the page sets this and `acceptTerms`
   * together; both stay separate fields here because they are separate affirmations in the
   * signed message.
   */
  acceptUndertaking: boolean;
}

/**
 * Context bound into the signature. Committing the amount, penalized-delinquency days,
 * and the block they were read at makes the signature a verifiable attestation: anyone can
 * replay `asOfBlock` on an archive node and confirm the figures against live chain state.
 */
export interface SignedClaimContext {
  network: string;
  /** The market the lender is claiming against. */
  market: string;
  /** Whole days the market has been in penalized delinquency, as of asOfBlock. */
  penalizedDays: number;
  /** Lender's owed amount (held + withdrawals), raw wei, as of asOfBlock. */
  amountOwedWei: string;
  /** Block number the figures were read at — the on-chain anchor for verification. */
  asOfBlock: number;
}

/** Full submission payload (form + signed claim context). */
export interface SubmitData {
  form: FormData;
  claim: SignedClaimContext;
}

// ========================================================================== //
//                              Form validation                               //
// ========================================================================== //

export function validateEmail(email: string): boolean {
  return /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,7})+$/.test(email);
}

const isBlank = (s: string): boolean => !s || s.replace(/\s/g, '').length < 1;

function getLocationError(d: FormData): string | undefined {
  if (!Country.getCountryByCode(d.country)) return 'Invalid country';
  return undefined;
}

function getContactInfoError(d: FormData): string | undefined {
  if (isBlank(d.name)) return 'Invalid name';
  if (isBlank(d.email) && isBlank(d.other)) return 'Invalid contact details';
  if (d.email && !validateEmail(d.email)) return 'Invalid email address';
  return undefined;
}

function getOptionsError(d: FormData): string | undefined {
  if (!d.acceptTerms) return 'Must accept terms';
  if (!d.acceptUndertaking) return 'Must agree to the Qualifying Lender undertaking';
  return undefined;
}

export function getFormDataError(d: FormData): string | undefined {
  return getLocationError(d) || getContactInfoError(d) || getOptionsError(d);
}

// ========================================================================== //
//                          Signature verification                            //
// ========================================================================== //

const CHAIN_IDS: Record<string, number> = { mainnet: 1, sepolia: 11155111 };

export function chainIdFor(network: string): number {
  return CHAIN_IDS[network] ?? 1;
}

export function domainFor(network: string): TypedDataDomain {
  return {
    name: 'Wildcat Claims',
    version: '1',
    chainId: chainIdFor(network),
  };
}

/** EIP-712 type definitions, exported so the frontend can build identical typed data. */
export const EIP712_TYPES = {
  Contact: [
    { name: 'name', type: 'string' },
    { name: 'email', type: 'string' },
    { name: 'other', type: 'string' },
  ],
  Location: [{ name: 'country', type: 'string' }],
  Options: [{ name: 'acceptTerms', type: 'bool' }],
  // The undertaking travels with its own text, so the signature commits to the wording agreed
  // to — not merely to a boolean whose meaning lives off-chain.
  // Only the agreement flag and the SHA-256 of the agreed text travel in the signature: the
  // wallet prompt stays short, and the digest still binds the exact wording (published via
  // GET /config and QUALIFYING_LENDER_AGREEMENT) beyond alteration.
  Undertaking: [
    { name: 'agreed', type: 'bool' },
    { name: 'sha256', type: 'bytes32' },
  ],
  Claim: [
    { name: 'network', type: 'string' },
    { name: 'market', type: 'address' },
    { name: 'penalizedDays', type: 'uint256' },
    { name: 'amountOwedWei', type: 'uint256' },
    { name: 'asOfBlock', type: 'uint256' },
  ],
  Data: [
    { name: 'contactInfo', type: 'Contact' },
    { name: 'location', type: 'Location' },
    { name: 'options', type: 'Options' },
    { name: 'undertaking', type: 'Undertaking' },
    { name: 'claim', type: 'Claim' },
  ],
};

const toTypedValue = (form: FormData, claim: SignedClaimContext) => ({
  contactInfo: { name: form.name, email: form.email || '', other: form.other || '' },
  location: { country: form.country },
  options: { acceptTerms: form.acceptTerms },
  undertaking: { agreed: form.acceptUndertaking, sha256: QUALIFYING_LENDER_AGREEMENT_SHA256 },
  claim: {
    network: claim.network,
    market: getAddress(claim.market),
    penalizedDays: claim.penalizedDays,
    amountOwedWei: claim.amountOwedWei,
    asOfBlock: claim.asOfBlock,
  },
});

export const toSignatureString = (form: FormData, claim: SignedClaimContext): string =>
  [
    `name: ${form.name || ''}`,
    `email: ${form.email || ''}`,
    `other: ${form.other || ''}`,
    `country: ${form.country}`,
    `acceptTerms: ${form.acceptTerms}`,
    `acceptUndertaking: ${form.acceptUndertaking}`,
    `undertakingSha256: ${QUALIFYING_LENDER_AGREEMENT_SHA256}`,
    `network: ${claim.network}`,
    `market: ${getAddress(claim.market)}`,
    `penalizedDays: ${claim.penalizedDays}`,
    `amountOwedWei: ${claim.amountOwedWei}`,
    `asOfBlock: ${claim.asOfBlock}`,
  ].join('\n');

/**
 * Recover the signer of an EIP-712 payload straight from its own JSON — the exact
 * `{ domain, types, message }` shape emitted in the downloadable "signed-message.json",
 * plus the detached `signature`. `EIP712Domain`, if present in `types`, is stripped
 * (ethers derives it from `domain`). Pure cryptography: no chain access, and the caller
 * is not trusted to have told the truth about who signed — the address is recovered.
 */
export function recoverTypedSigner(
  domain: TypedDataDomain,
  types: Record<string, Array<{ name: string; type: string }>>,
  message: Record<string, unknown>,
  signature: string
): string {
  const t: Record<string, Array<{ name: string; type: string }>> = { ...types };
  delete t.EIP712Domain;
  return verifyTypedData(domain, t, message, signature);
}

/** Recover the signer address from an EIP-712 or personal_sign signature (EOA / ECDSA). */
export function verifySignature(
  form: FormData,
  claim: SignedClaimContext,
  signature: string
): string {
  if (signature.includes('personal_sign_')) {
    return verifyMessage(toSignatureString(form, claim), signature.replace('personal_sign_', ''));
  }
  return verifyTypedData(domainFor(claim.network), EIP712_TYPES, toTypedValue(form, claim), signature);
}

/**
 * The 32-byte digest the lender signed — the value an EIP-1271 wallet (e.g. a Safe) checks via
 * isValidSignature. EIP-712 path: the typed-data hash; personal_sign path: the EIP-191 message hash.
 */
/**
 * The 32-byte digest of an EIP-712 payload *exactly as submitted* — the value an EIP-1271
 * wallet checks. Unlike {@link claimDigest} this re-hashes the caller's own `{domain, types,
 * message}` rather than rebuilding it from a form, so a Safe's proof can be verified without
 * assuming its shape still matches what this deployment would produce today. `EIP712Domain`
 * is stripped, as ethers derives it from `domain`.
 */
export function typedPayloadHash(
  domain: TypedDataDomain,
  types: Record<string, Array<{ name: string; type: string }>>,
  message: Record<string, unknown>
): string {
  const t: Record<string, Array<{ name: string; type: string }>> = { ...types };
  delete t.EIP712Domain;
  return TypedDataEncoder.hash(domain, t, message);
}

/**
 * Parse the personal_sign text back into its fields. The signed text is what
 * {@link toSignatureString} produced: one `key: value` per line, values possibly empty, split
 * on the FIRST colon so a value containing one survives. Lines with no colon (the debug
 * banner) are skipped; a caller that cares about them inspects the raw text.
 */
export function parseSignatureLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).replace(/^ /, '');
  }
  return out;
}

export function claimDigest(form: FormData, claim: SignedClaimContext, signature: string): string {
  return signature.includes('personal_sign_')
    ? hashMessage(toSignatureString(form, claim))
    : TypedDataEncoder.hash(domainFor(claim.network), EIP712_TYPES, toTypedValue(form, claim));
}

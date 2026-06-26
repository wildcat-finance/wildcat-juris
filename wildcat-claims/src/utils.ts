import { Country } from 'country-state-city';
import { verifyMessage, verifyTypedData, getAddress, type TypedDataDomain } from 'ethers';
import type { ClaimResult } from './wildcat/eligibility';

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
  willingToSpeakToLEO: boolean;
  willingToLitigate: boolean;
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

/** Persisted claim record: one lender, one market. */
export type AccountData = FormData & {
  address: string;
  signature: string;
  network: string;
  market: string;
  marketName: string;
  borrower: string;
  assetSymbol: string;
  assetDecimals: number;
  amountOwedWei: string;
  heldOwedWei: string;
  withdrawalsOwedWei: string;
  withdrawalsError: boolean;
  inDefault: boolean;
  isClosed: boolean;
  timeDelinquent: number;
  delinquencyGracePeriod: number;
  /** Penalized-delinquency days, as attested in the signature. */
  penalizedDays: number;
  /** Block the attested figures were read at (on-chain anchor for verification). */
  asOfBlock: number;
  /** Server-stamped time the signed claim was received (ISO-8601, UTC). */
  submittedAt: string;
};

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
  if (!(d.willingToLitigate || d.willingToSpeakToLEO)) return 'Invalid options';
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
  Options: [
    { name: 'acceptTerms', type: 'bool' },
    { name: 'willingToSpeakToLEO', type: 'bool' },
    { name: 'willingToLitigate', type: 'bool' },
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
    { name: 'claim', type: 'Claim' },
  ],
};

const toTypedValue = (form: FormData, claim: SignedClaimContext) => ({
  contactInfo: { name: form.name, email: form.email || '', other: form.other || '' },
  location: { country: form.country },
  options: {
    acceptTerms: form.acceptTerms,
    willingToSpeakToLEO: form.willingToSpeakToLEO,
    willingToLitigate: form.willingToLitigate,
  },
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
    `willingToSpeakToLEO: ${form.willingToSpeakToLEO}`,
    `willingToLitigate: ${form.willingToLitigate}`,
    `network: ${claim.network}`,
    `market: ${getAddress(claim.market)}`,
    `penalizedDays: ${claim.penalizedDays}`,
    `amountOwedWei: ${claim.amountOwedWei}`,
    `asOfBlock: ${claim.asOfBlock}`,
  ].join('\n');

/** Recover the signer address from an EIP-712 or personal_sign signature. */
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

export function toAccount(
  address: string,
  form: FormData,
  claim: SignedClaimContext,
  signature: string,
  result: ClaimResult,
  submittedAt: string
): AccountData {
  return {
    ...form,
    address: getAddress(address),
    signature,
    network: claim.network,
    market: getAddress(claim.market),
    marketName: result.name,
    borrower: result.borrower,
    assetSymbol: result.assetSymbol,
    assetDecimals: result.assetDecimals,
    // Attested (signed) figures are the figures of record.
    amountOwedWei: claim.amountOwedWei,
    heldOwedWei: result.heldOwedWei,
    withdrawalsOwedWei: result.withdrawalsOwedWei,
    withdrawalsError: result.withdrawalsError,
    inDefault: result.inDefault,
    isClosed: result.isClosed,
    timeDelinquent: result.timeDelinquent,
    delinquencyGracePeriod: result.delinquencyGracePeriod,
    penalizedDays: claim.penalizedDays,
    asOfBlock: claim.asOfBlock,
    submittedAt,
  };
}

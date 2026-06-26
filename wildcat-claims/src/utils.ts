import { Country, State, City } from 'country-state-city';
import { verifyMessage, verifyTypedData, keccak256, toUtf8Bytes, getAddress, type TypedDataDomain } from 'ethers';
import type { EligibleClaim } from './wildcat/eligibility';

// ========================================================================== //
//                                   Types                                    //
// ========================================================================== //

export interface FormData {
  name: string;
  email: string;
  other: string;
  country: string;
  state: string;
  city: string;
  acceptTerms: boolean;
  willingToSpeakToLEO: boolean;
  willingToLitigate: boolean;
}

/** Context bound into the signature so a claim cannot be replayed elsewhere. */
export interface SignedClaimContext {
  network: string;
  /** Eligibility threshold (unix seconds); 0 when reading at 'latest'. */
  eligibilityTimestamp: number;
  /** keccak256 over the sorted, lowercased eligible market addresses. */
  marketsHash: string;
}

/** Full submission payload (form + signed claim context). */
export interface SubmitData {
  form: FormData;
  claim: SignedClaimContext;
}

/** Persisted claim record. */
export type AccountData = FormData & {
  address: string;
  signature: string;
  network: string;
  /** The incident this claim belongs to (per-market scoping namespace). */
  incidentId: string;
  /** Block the eligibility reads were pinned to (audit trail). */
  blockNumber: number;
  /** Eligibility threshold (unix seconds); 0 when reading at 'latest'. */
  eligibilityTimestamp: number;
  marketsHash: string;
  totalAmountOwedWei: string;
  claims: EligibleClaim[];
};

// ========================================================================== //
//                              Form validation                               //
// ========================================================================== //

export function validateEmail(email: string): boolean {
  return /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,7})+$/.test(email);
}

const isBlank = (s: string): boolean => !s || s.replace(/\s/g, '').length < 1;

function getLocationError(d: FormData): string | undefined {
  const country = Country.getCountryByCode(d.country);
  if (!country) return 'Invalid country';
  const state = State.getStatesOfCountry(country.isoCode).find(
    (s) => s.isoCode.toLowerCase() === d.state.toLowerCase()
  );
  if (!state || state.countryCode !== d.country) return 'Invalid state';
  const cities = City.getCitiesOfState(d.country, d.state);
  if (!cities.length && d.city === '') return undefined;
  if (!cities.map((c) => c.name.toLowerCase()).includes(d.city.toLowerCase())) return 'Invalid city';
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
  Location: [
    { name: 'country', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'city', type: 'string' },
  ],
  Options: [
    { name: 'acceptTerms', type: 'bool' },
    { name: 'willingToSpeakToLEO', type: 'bool' },
    { name: 'willingToLitigate', type: 'bool' },
  ],
  Claim: [
    { name: 'network', type: 'string' },
    { name: 'eligibilityTimestamp', type: 'uint256' },
    { name: 'marketsHash', type: 'bytes32' },
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
  location: { country: form.country, state: form.state, city: form.city || '' },
  options: {
    acceptTerms: form.acceptTerms,
    willingToSpeakToLEO: form.willingToSpeakToLEO,
    willingToLitigate: form.willingToLitigate,
  },
  claim: {
    network: claim.network,
    eligibilityTimestamp: claim.eligibilityTimestamp,
    marketsHash: claim.marketsHash,
  },
});

export const toSignatureString = (form: FormData, claim: SignedClaimContext): string =>
  [
    `name: ${form.name || ''}`,
    `email: ${form.email || ''}`,
    `other: ${form.other || ''}`,
    `country: ${form.country}`,
    `state: ${form.state}`,
    `city: ${form.city || ''}`,
    `acceptTerms: ${form.acceptTerms}`,
    `willingToSpeakToLEO: ${form.willingToSpeakToLEO}`,
    `willingToLitigate: ${form.willingToLitigate}`,
    `network: ${claim.network}`,
    `eligibilityTimestamp: ${claim.eligibilityTimestamp}`,
    `marketsHash: ${claim.marketsHash}`,
  ].join('\n');

/** keccak256 over sorted, lowercased market addresses — order-independent commitment. */
export function computeMarketsHash(markets: string[]): string {
  const sorted = markets.map((m) => m.toLowerCase()).sort();
  return keccak256(toUtf8Bytes(sorted.join(',')));
}

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
  claims: EligibleClaim[],
  totalAmountOwedWei: string,
  incidentId: string,
  blockNumber: number
): AccountData {
  return {
    ...form,
    address: getAddress(address),
    signature,
    network: claim.network,
    incidentId,
    blockNumber,
    eligibilityTimestamp: claim.eligibilityTimestamp,
    marketsHash: claim.marketsHash,
    totalAmountOwedWei,
    claims,
  };
}

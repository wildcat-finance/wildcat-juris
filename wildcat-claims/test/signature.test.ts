import { describe, it, expect } from 'vitest';
import { Wallet, getAddress } from 'ethers';
import {
  verifySignature,
  domainFor,
  EIP712_TYPES,
  toSignatureString,
  computeMarketsHash,
  type FormData,
  type SignedClaimContext,
} from '../src/utils';

const form: FormData = {
  name: 'Ada Lovelace',
  email: 'ada@example.io',
  other: '',
  country: 'US',
  state: 'CA',
  city: '',
  acceptTerms: true,
  willingToSpeakToLEO: false,
  willingToLitigate: true,
};

const claim: SignedClaimContext = {
  network: 'mainnet',
  eligibilityTimestamp: 1_700_000_000,
  marketsHash: computeMarketsHash(['0xabc', '0xdef']),
};

// Mirrors the structure the frontend signs (and the server reconstructs internally).
const typedValue = (f: FormData, c: SignedClaimContext) => ({
  contactInfo: { name: f.name, email: f.email, other: f.other },
  location: { country: f.country, state: f.state, city: f.city },
  options: {
    acceptTerms: f.acceptTerms,
    willingToSpeakToLEO: f.willingToSpeakToLEO,
    willingToLitigate: f.willingToLitigate,
  },
  claim: { network: c.network, eligibilityTimestamp: c.eligibilityTimestamp, marketsHash: c.marketsHash },
});

describe('signature verification', () => {
  it('round-trips an EIP-712 signature to the signer address', async () => {
    const w = Wallet.createRandom();
    const sig = await w.signTypedData(domainFor(claim.network), EIP712_TYPES, typedValue(form, claim));
    expect(getAddress(verifySignature(form, claim, sig))).toBe(getAddress(w.address));
  });

  it('round-trips a personal_sign signature to the signer address', async () => {
    const w = Wallet.createRandom();
    const sig = await w.signMessage(toSignatureString(form, claim));
    expect(getAddress(verifySignature(form, claim, 'personal_sign_' + sig))).toBe(getAddress(w.address));
  });

  it('does not recover the signer when the committed market set is tampered', async () => {
    const w = Wallet.createRandom();
    const sig = await w.signTypedData(domainFor(claim.network), EIP712_TYPES, typedValue(form, claim));
    const tampered = { ...claim, marketsHash: computeMarketsHash(['0xother']) };
    expect(getAddress(verifySignature(form, tampered, sig))).not.toBe(getAddress(w.address));
  });

  it('does not recover the signer when replayed against another network (chainId-bound)', async () => {
    const w = Wallet.createRandom();
    const sig = await w.signTypedData(domainFor(claim.network), EIP712_TYPES, typedValue(form, claim));
    expect(getAddress(verifySignature(form, { ...claim, network: 'sepolia' }, sig))).not.toBe(
      getAddress(w.address)
    );
  });
});

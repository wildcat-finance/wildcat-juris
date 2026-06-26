import { describe, it, expect } from 'vitest';
import { Wallet, getAddress } from 'ethers';
import {
  verifySignature,
  domainFor,
  EIP712_TYPES,
  toSignatureString,
  type FormData,
  type SignedClaimContext,
} from '../src/utils';

const MARKET_A = getAddress('0x00000000000000000000000000000000000000a1');
const MARKET_B = getAddress('0x00000000000000000000000000000000000000b2');

const form: FormData = {
  name: 'Ada Lovelace',
  email: 'ada@example.io',
  other: '',
  country: 'US',
  acceptTerms: true,
  willingToSpeakToLEO: false,
  willingToLitigate: true,
};

const claim: SignedClaimContext = { network: 'mainnet', market: MARKET_A, penalizedDays: 42 };

// Mirrors the structure the frontend signs (and the server reconstructs internally).
const typedValue = (f: FormData, c: SignedClaimContext) => ({
  contactInfo: { name: f.name, email: f.email, other: f.other },
  location: { country: f.country },
  options: {
    acceptTerms: f.acceptTerms,
    willingToSpeakToLEO: f.willingToSpeakToLEO,
    willingToLitigate: f.willingToLitigate,
  },
  claim: { network: c.network, market: c.market, penalizedDays: c.penalizedDays },
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

  it('does not recover the signer when the committed market is swapped', async () => {
    const w = Wallet.createRandom();
    const sig = await w.signTypedData(domainFor(claim.network), EIP712_TYPES, typedValue(form, claim));
    expect(getAddress(verifySignature(form, { ...claim, market: MARKET_B }, sig))).not.toBe(
      getAddress(w.address)
    );
  });

  it('does not recover the signer when replayed against another network (chainId-bound)', async () => {
    const w = Wallet.createRandom();
    const sig = await w.signTypedData(domainFor(claim.network), EIP712_TYPES, typedValue(form, claim));
    expect(getAddress(verifySignature(form, { ...claim, network: 'sepolia' }, sig))).not.toBe(
      getAddress(w.address)
    );
  });
});

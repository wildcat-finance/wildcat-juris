import { describe, it, expect } from 'vitest';
import { Wallet, getAddress, verifyTypedData } from 'ethers';
import {
  verifySignature,
  domainFor,
  EIP712_TYPES,
  toSignatureString,
  getFormDataError,
  QUALIFYING_LENDER_UNDERTAKING,
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
  acceptUndertaking: true,
};

const claim: SignedClaimContext = {
  network: 'mainnet',
  market: MARKET_A,
  penalizedDays: 42,
  amountOwedWei: '1000000000000000000',
  asOfBlock: 20_500_000,
};

// Mirrors the structure the frontend signs (and the server reconstructs internally).
const typedValue = (f: FormData, c: SignedClaimContext) => ({
  contactInfo: { name: f.name, email: f.email, other: f.other },
  location: { country: f.country },
  options: { acceptTerms: f.acceptTerms },
  undertaking: { agreed: f.acceptUndertaking, text: QUALIFYING_LENDER_UNDERTAKING },
  claim: {
    network: c.network,
    market: c.market,
    penalizedDays: c.penalizedDays,
    amountOwedWei: c.amountOwedWei,
    asOfBlock: c.asOfBlock,
  },
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

  it('does not recover the signer when the undertaking agreement is flipped', async () => {
    const w = Wallet.createRandom();
    const sig = await w.signTypedData(domainFor(claim.network), EIP712_TYPES, typedValue(form, claim));
    expect(
      getAddress(verifySignature({ ...form, acceptUndertaking: false }, claim, sig))
    ).not.toBe(getAddress(w.address));
  });

  it('does not recover the signer when the undertaking wording is altered', async () => {
    const w = Wallet.createRandom();
    // Sign the real typed data, then verify against typed data carrying reworded undertaking text.
    const sig = await w.signTypedData(domainFor(claim.network), EIP712_TYPES, typedValue(form, claim));
    const tampered = {
      ...typedValue(form, claim),
      undertaking: { agreed: true, text: QUALIFYING_LENDER_UNDERTAKING.replace('shall not', 'may') },
    };
    expect(getAddress(verifyTypedData(domainFor(claim.network), EIP712_TYPES, tampered, sig))).not.toBe(
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

describe('Qualifying Lender undertaking', () => {
  it('is committed verbatim in both signing paths', () => {
    expect(toSignatureString(form, claim)).toContain(QUALIFYING_LENDER_UNDERTAKING);
    expect(JSON.stringify(typedValue(form, claim))).toContain(
      JSON.stringify(QUALIFYING_LENDER_UNDERTAKING).slice(1, -1)
    );
  });

  it('is rejected server-side when not agreed to', () => {
    expect(getFormDataError({ ...form, acceptUndertaking: false })).toBe(
      'Must agree to the Qualifying Lender undertaking'
    );
    expect(getFormDataError(form)).toBeUndefined();
  });
});

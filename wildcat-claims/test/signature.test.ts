import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { Wallet, getAddress, verifyTypedData } from 'ethers';
import {
  verifySignature,
  domainFor,
  EIP712_TYPES,
  toSignatureString,
  getFormDataError,
  QUALIFYING_LENDER_UNDERTAKING,
  QUALIFYING_LENDER_DEFINITION_LIST,
  QUALIFYING_LENDER_AGREEMENT,
  QUALIFYING_LENDER_AGREEMENT_SHA256,
  type FormData,
  type SignedClaimContext,
} from '../src/utils';

// Independent SHA-256, so the digest assertions do not just restate src/utils.ts back to itself.
const sha256Of = (t: string) => '0x' + createHash('sha256').update(t, 'utf8').digest('hex');

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
  undertaking: { agreed: f.acceptUndertaking, sha256: QUALIFYING_LENDER_AGREEMENT_SHA256 },
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

  it('does not recover the signer when the agreed text is reworded (digest changes)', async () => {
    const w = Wallet.createRandom();
    // Sign the real typed data, then verify against a digest taken over reworded text.
    const sig = await w.signTypedData(domainFor(claim.network), EIP712_TYPES, typedValue(form, claim));
    const reworded = QUALIFYING_LENDER_AGREEMENT.replace('shall not', 'may');
    const tampered = {
      ...typedValue(form, claim),
      undertaking: { agreed: true, sha256: sha256Of(reworded) },
    };
    expect(sha256Of(reworded)).not.toBe(QUALIFYING_LENDER_AGREEMENT_SHA256);
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
  it('is committed by digest in both signing paths, not as legalese', () => {
    // The flat message carries the digest and not the text; the typed value likewise.
    expect(toSignatureString(form, claim)).toContain(
      `undertakingSha256: ${QUALIFYING_LENDER_AGREEMENT_SHA256}`
    );
    expect(toSignatureString(form, claim)).not.toContain(QUALIFYING_LENDER_UNDERTAKING);
    expect(typedValue(form, claim).undertaking.sha256).toBe(QUALIFYING_LENDER_AGREEMENT_SHA256);
  });

  it('digests the exact published document — undertaking then each definition', () => {
    expect(QUALIFYING_LENDER_AGREEMENT).toBe(
      [QUALIFYING_LENDER_UNDERTAKING, ...QUALIFYING_LENDER_DEFINITION_LIST].join('\n\n')
    );
    // Recomputed independently of src/utils.ts, the way an outside verifier would.
    expect(QUALIFYING_LENDER_AGREEMENT_SHA256).toBe(sha256Of(QUALIFYING_LENDER_AGREEMENT));
  });

  it('defines every term the undertaking turns on, and daisy-chains them', () => {
    const defined = (t: string) => QUALIFYING_LENDER_DEFINITION_LIST.some((d) => d.startsWith(`"${t}"`));
    // Terms used in the undertaking itself (Market is evident on its face, so not defined)...
    expect(defined('Qualifying Lender')).toBe(true);
    expect(defined('Identifying Particulars')).toBe(true);
    // ...and the terms those definitions in turn rely on.
    expect(defined('Company')).toBe(true);
    expect(defined('default')).toBe(true);
    expect(defined('borrower verification data')).toBe(true);
  });

  it('is rejected server-side when not agreed to', () => {
    expect(getFormDataError({ ...form, acceptUndertaking: false })).toBe(
      'Must agree to the Qualifying Lender undertaking'
    );
    expect(getFormDataError(form)).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getAddress } from 'ethers';
import { verifySignature, claimDigest, type FormData, type SignedClaimContext } from '../src/utils';

// The committed examples/ files must always verify with the real signing code — this guards
// against src/utils.ts drifting away from the published proofs. Regenerate with `npm run examples`.

const examplesDir = path.join(__dirname, '..', 'examples');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(examplesDir, name), 'utf8'));

// Reconstruct the (form, claim) inputs from a signed payload so we can re-run verification.
function formFrom(msg: any): FormData {
  return {
    name: msg.contactInfo.name,
    email: msg.contactInfo.email,
    other: msg.contactInfo.other,
    country: msg.location.country,
    acceptTerms: msg.options.acceptTerms,
  };
}
function claimFrom(msg: any): SignedClaimContext {
  return {
    network: msg.claim.network,
    market: msg.claim.market,
    penalizedDays: msg.claim.penalizedDays,
    amountOwedWei: msg.claim.amountOwedWei,
    asOfBlock: msg.claim.asOfBlock,
  };
}

describe('committed proof examples', () => {
  it('EIP-712 proof recovers the stated signer and matches its typed-data hash', () => {
    const payload = read('eip712-signed-payload.json');
    const proof = read('eip712-proof.json');
    const form = formFrom(payload.message);
    const claim = claimFrom(payload.message);

    expect(getAddress(verifySignature(form, claim, proof.signature))).toBe(getAddress(proof.signer));
    expect(claimDigest(form, claim, proof.signature)).toBe(proof.typedDataHash);
    expect(proof.signatureValid).toBe(true);
  });

  it('personal_sign proof recovers the stated signer and matches its message hash', () => {
    const eip712 = read('eip712-signed-payload.json'); // same (form, claim) inputs
    const proof = read('personal-sign-proof.json');
    const form = formFrom(eip712.message);
    const claim = claimFrom(eip712.message);

    expect(proof.signature.startsWith('personal_sign_')).toBe(true);
    expect(getAddress(verifySignature(form, claim, proof.signature))).toBe(getAddress(proof.signer));
    expect(claimDigest(form, claim, proof.signature)).toBe(proof.messageHash);
    expect(proof.signatureValid).toBe(true);
  });
});

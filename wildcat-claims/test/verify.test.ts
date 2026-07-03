import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getAddress } from 'ethers';
import { reconstruct, verifyProof, NetworkMismatchError, type ProofBundle } from '../src/verify';
import { loadConfig } from '../src/wildcat/config';

const examplesDir = path.join(__dirname, '..', 'examples');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(examplesDir, name), 'utf8'));

describe('verify: reconstruct', () => {
  it('maps typed-data message back to (form, claim)', () => {
    const payload = read('eip712-signed-payload.json');
    const { form, claim } = reconstruct(payload.message);
    expect(form).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.io',
      other: '',
      country: 'GB',
      acceptTerms: true,
    });
    expect(claim.network).toBe('mainnet');
    expect(claim.market).toBe(getAddress('0x00000000000000000000000000000000000000a1'));
    expect(claim.penalizedDays).toBe(118);
    expect(claim.amountOwedWei).toBe('250000000000');
    expect(claim.asOfBlock).toBe(20812345);
  });
});

describe('verify: network guard', () => {
  it('throws NetworkMismatchError before any chain read when networks differ', async () => {
    const payload = read('eip712-signed-payload.json');
    const proof = read('eip712-proof.json');
    const bundle: ProofBundle = { payload, proof };
    // Server config is mainnet by default; force the claim to a different network.
    bundle.payload.message.claim.network = 'sepolia';
    await expect(verifyProof(bundle, loadConfig())).rejects.toBeInstanceOf(NetworkMismatchError);
  });
});

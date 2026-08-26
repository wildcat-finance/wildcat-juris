import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { Wallet, TypedDataEncoder } from 'ethers';
import { createApp } from '../src/app';
import {
  EIP712_TYPES,
  QUALIFYING_LENDER_AGREEMENT_SHA256,
  domainFor,
  toSignatureString,
  type FormData,
  type SignedClaimContext,
} from '../src/utils';

/**
 * A stub JSON-RPC that makes exactly ONE address look like a Safe: non-empty code, and
 * isValidSignature returning the EIP-1271 magic value. Scoped to that address deliberately —
 * a stub that answered for everyone would make every mismatched signature verify, and these
 * tests would pass no matter what /verify did. It answers nothing else, so the on-chain replay
 * fails; that is deliberate — these tests are about layers 1-3, and the replay failing is
 * itself asserted below to be reported rather than fatal.
 */
const SAFE = '0x0000000000000000000000000000000000005afe';
const MAGIC = '0x1626ba7e' + '00'.repeat(28);
function stubRpc(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body || '{}');
      const target = String(params?.[0]?.to ?? params?.[0] ?? '').toLowerCase();
      const isSafe = target === SAFE;
      const result =
        method === 'eth_getCode'
          ? isSafe
            ? '0x60806040'
            : '0x'
          : method === 'eth_call'
            ? isSafe
              ? MAGIC
              : '0x'
            : '0x1';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      r({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    })
  );
}

const form: FormData = {
  name: 'Ada Lovelace',
  email: 'ada@example.io',
  other: '',
  country: 'GB',
  acceptTerms: true,
  acceptUndertaking: true,
};

// No market: the signature/domain/undertaking layers are what these tests exercise, and
// omitting it keeps the on-chain replay (and any RPC call) out of the way.
const claim: SignedClaimContext = {
  network: 'mainnet',
  market: '',
  penalizedDays: 118,
  amountOwedWei: '250000000000',
  asOfBlock: 20812345,
};

const message = (over: Record<string, unknown> = {}) => ({
  contactInfo: { name: form.name, email: form.email, other: '' },
  location: { country: form.country },
  options: { acceptTerms: true },
  undertaking: { agreed: true, sha256: QUALIFYING_LENDER_AGREEMENT_SHA256 },
  claim: { ...claim, market: '0x00000000000000000000000000000000000000A1' },
  ...over,
});

let rpc: Awaited<ReturnType<typeof stubRpc>>;
let server: Server;
let base: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  rpc = await stubRpc();
  for (const k of ['RPC_URL', 'DEBUG_MODE', 'DEBUG_KEY']) saved[k] = process.env[k];
  process.env.RPC_URL = rpc.url;
  delete process.env.DEBUG_MODE;
  delete process.env.DEBUG_KEY;
  server = createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rpc.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const verify = (body: unknown) =>
  fetch(base + '/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: r.status === 200 ? await r.json() : await r.text() }));

// Typed data must be presented without EIP712Domain, exactly as the download does.
const TYPES = EIP712_TYPES;

describe('/verify · EIP-712 proof from a key-holding wallet', () => {
  it('establishes the signer, the domain and the undertaking', async () => {
    const w = Wallet.createRandom();
    const msg = message();
    const signature = await w.signTypedData(domainFor('mainnet'), TYPES, msg);
    const { body: r } = await verify({
      signed: { domain: domainFor('mainnet'), types: TYPES, message: msg },
      proof: { signer: w.address, signature },
    });
    expect(r.signature.valid).toBe(true);
    expect(r.signature.method).toBe('ecdsa');
    expect(r.signature.recovered).toBe(w.address);
    expect(r.domain.applicable).toBe(true);
    expect(r.domain.matches).toBe(true);
    expect(r.undertaking).toMatchObject({ present: true, agreed: true, matches: true });
  });

  it('is invalid when the domain is not this deployment’s', async () => {
    const w = Wallet.createRandom();
    const msg = message();
    const foreign = { name: 'Someone Else', version: '1', chainId: 1 };
    const signature = await w.signTypedData(foreign, TYPES, msg);
    const { body: r } = await verify({
      signed: { domain: foreign, types: TYPES, message: msg },
      proof: { signer: w.address, signature },
    });
    expect(r.domain.matches).toBe(false);
    expect(r.overall).toBe('invalid');
  });

  it('is a mismatch when the undertaking digest is not the published one', async () => {
    const w = Wallet.createRandom();
    const msg = message({ undertaking: { agreed: true, sha256: '0x' + 'ab'.repeat(32) } });
    const signature = await w.signTypedData(domainFor('mainnet'), TYPES, msg);
    const { body: r } = await verify({
      signed: { domain: domainFor('mainnet'), types: TYPES, message: msg },
      proof: { signer: w.address, signature },
    });
    expect(r.signature.valid).toBe(true);
    expect(r.undertaking.matches).toBe(false);
    expect(r.undertaking.expected).toBe(QUALIFYING_LENDER_AGREEMENT_SHA256);
    expect(r.overall).toBe('mismatch');
  });

  it('is a mismatch when the signer did not affirm the undertaking', async () => {
    const w = Wallet.createRandom();
    const msg = message({
      undertaking: { agreed: false, sha256: QUALIFYING_LENDER_AGREEMENT_SHA256 },
    });
    const signature = await w.signTypedData(domainFor('mainnet'), TYPES, msg);
    const { body: r } = await verify({
      signed: { domain: domainFor('mainnet'), types: TYPES, message: msg },
      proof: { signer: w.address, signature },
    });
    expect(r.undertaking.agreed).toBe(false);
    expect(r.overall).toBe('mismatch');
  });

  it('reports an absent undertaking as unestablished, not as a forgery', async () => {
    const w = Wallet.createRandom();
    // A pre-undertaking payload: the member goes, and so does its now-orphaned type.
    const types: any = { ...TYPES, Data: TYPES.Data.filter((f) => f.name !== 'undertaking') };
    delete types.Undertaking;
    const msg = message();
    delete (msg as any).undertaking;
    const signature = await w.signTypedData(domainFor('mainnet'), types, msg);
    const { body: r } = await verify({
      signed: { domain: domainFor('mainnet'), types, message: msg },
      proof: { signer: w.address, signature },
    });
    expect(r.signature.valid).toBe(true);
    expect(r.undertaking).toMatchObject({ present: false, agreed: null, matches: null });
    expect(r.overall).not.toBe('valid');
  });

  it('is invalid when the signature recovers to someone other than the named signer', async () => {
    const w = Wallet.createRandom();
    const msg = message();
    const signature = await w.signTypedData(domainFor('mainnet'), TYPES, msg);
    const { body: r } = await verify({
      signed: { domain: domainFor('mainnet'), types: TYPES, message: msg },
      proof: { signer: Wallet.createRandom().address, signature },
    });
    expect(r.signature.valid).toBe(false);
    expect(r.overall).toBe('invalid');
  });
});

describe('/verify · Safe (EIP-1271), which has no key to recover', () => {
  it('accepts a proof the wallet contract authorizes', async () => {
    const msg = message();
    // Not a recoverable signature for `safe` — a Safe's bytes never recover to it.
    const signature = await Wallet.createRandom().signTypedData(domainFor('mainnet'), TYPES, msg);
    const { body: r } = await verify({
      signed: { domain: domainFor('mainnet'), types: TYPES, message: msg },
      proof: { signer: SAFE, signature },
    });
    expect(r.signature.valid).toBe(true);
    expect(r.signature.method).toBe('erc1271');
    expect(r.signature.recovered.toLowerCase()).toBe(SAFE);
    expect(r.undertaking.matches).toBe(true);
  });

  it('hashes the payload as submitted, matching what the wallet was asked to authorize', async () => {
    const msg = message();
    const t: any = { ...TYPES };
    expect(TypedDataEncoder.hash(domainFor('mainnet'), t, msg)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('/verify · personal_sign proof, which carries no domain', () => {
  it('establishes the signer and the undertaking, and reports the domain as not applicable', async () => {
    const w = Wallet.createRandom();
    const c = { ...claim, market: '0x00000000000000000000000000000000000000A1' };
    const text = toSignatureString(form, c);
    const signature = 'personal_sign_' + (await w.signMessage(text));
    const { body: r } = await verify({
      signed: { scheme: 'EIP-191 personal_sign', message: text },
      proof: { signer: w.address, signature },
    });
    expect(r.signature.valid).toBe(true);
    expect(r.signature.scheme).toBe('personal_sign');
    expect(r.signature.recovered).toBe(w.address);
    expect(r.domain.applicable).toBe(false);
    expect(r.domain.matches).toBe(null);
    expect(r.undertaking).toMatchObject({ present: true, agreed: true, matches: true });
    expect(r.overall).not.toBe('invalid');
  });

  it('reports a failed on-chain replay instead of failing the request', async () => {
    const w = Wallet.createRandom();
    const c = { ...claim, market: '0x00000000000000000000000000000000000000A1' };
    const text = toSignatureString(form, c);
    const { status, body: r } = await verify({
      signed: { message: text },
      proof: { signer: w.address, signature: 'personal_sign_' + (await w.signMessage(text)) },
    });
    expect(status).toBe(200);
    expect(r.onChain.checked).toBe(false);
    expect(String(r.onChain.error)).toContain('On-chain replay failed');
    // Signer and undertaking stand on their own; only the replay is unproven.
    expect(r.signature.valid).toBe(true);
    expect(r.overall).toBe('signature-valid');
  });

  it('reads the claim back out of the signed text', async () => {
    const w = Wallet.createRandom();
    const c = { ...claim, market: '0x00000000000000000000000000000000000000A1' };
    const text = toSignatureString(form, c);
    const { body: r } = await verify({
      signed: { message: text },
      proof: { signer: w.address, signature: 'personal_sign_' + (await w.signMessage(text)) },
    });
    expect(r.claim.penalizedDays).toBe(118);
    expect(r.claim.amountOwedWei).toBe('250000000000');
    expect(r.claim.asOfBlock).toBe(20812345);
  });

  it('rejects text that was not what was signed', async () => {
    const w = Wallet.createRandom();
    const c = { ...claim, market: '0x00000000000000000000000000000000000000A1' };
    const signature = 'personal_sign_' + (await w.signMessage(toSignatureString(form, c)));
    const { body: r } = await verify({
      signed: { message: toSignatureString(form, { ...c, amountOwedWei: '1' }) },
      proof: { signer: w.address, signature },
    });
    expect(r.signature.valid).toBe(false);
    expect(r.overall).toBe('invalid');
  });
});

describe('/verify · malformed input', () => {
  it('asks for what is missing rather than guessing', async () => {
    expect((await verify({})).status).toBe(400);
    expect((await verify({ signed: { message: {} } })).status).toBe(400);
    expect((await verify({ signed: { message: 'text' } })).status).toBe(400);
    const typedNoDomain = await verify({
      signed: { message: message() },
      proof: { signature: '0x00' },
    });
    expect(typedNoDomain.status).toBe(400);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { Wallet } from 'ethers';
import { createApp } from '../src/app';
import { DEBUG_COOKIE } from '../src/debugSession';
import {
  EIP712_TYPES,
  QUALIFYING_LENDER_AGREEMENT_SHA256,
  domainFor,
} from '../src/utils';

/**
 * Where the debug session and the verifier meet. A dry run has to be checkable end to end,
 * which means /verify must expect the session's own domain — and the same proof must stay
 * invalid to anyone outside the session, or a dry run built on faked holdings would verify
 * as real evidence. No `market`, so the on-chain replay never runs and no RPC is touched.
 */
const KEY = 'verify-debug-key-' + 'q'.repeat(24);

let server: Server;
let base: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['DEBUG_KEY', 'DEBUG_MODE']) saved[k] = process.env[k];
  process.env.DEBUG_KEY = KEY;
  delete process.env.DEBUG_MODE;
  server = createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const message = {
  contactInfo: { name: 'Dry Run', email: 'dry@example.com', other: '' },
  location: { country: 'GB' },
  options: { acceptTerms: true },
  undertaking: { agreed: true, sha256: QUALIFYING_LENDER_AGREEMENT_SHA256 },
  claim: {
    network: 'mainnet',
    market: '0x0000000000000000000000000000000000000000',
    penalizedDays: 91,
    amountOwedWei: '100',
    asOfBlock: 0,
  },
};

const verify = (body: unknown, cookie?: string) =>
  fetch(base + '/verify', {
    method: 'POST',
    headers: cookie
      ? { 'content-type': 'application/json', cookie }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

describe('a dry-run proof is checkable inside its session and invalid outside it', () => {
  let cookie: string;
  let payload: unknown;
  let debugDomain: Record<string, unknown>;

  beforeAll(async () => {
    const res = await fetch(base + '/debug/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY }),
    });
    cookie = res.headers.get('set-cookie')!.split(';')[0];
    expect(cookie.startsWith(`${DEBUG_COOKIE}=`)).toBe(true);

    const cfg = await (await fetch(base + '/config', { headers: { cookie } })).json();
    debugDomain = cfg.domain;
    const w = Wallet.createRandom();
    payload = {
      signed: { domain: debugDomain, types: EIP712_TYPES, message },
      proof: {
        signer: w.address,
        signature: await w.signTypedData(debugDomain as any, EIP712_TYPES, message),
      },
    };
  });

  it('signs under a domain that is not the production one', () => {
    expect(debugDomain.name).not.toBe(domainFor('mainnet').name);
    expect(String(debugDomain.name)).toContain('DEBUG');
  });

  it('verifies inside the session', async () => {
    const r = await verify(payload, cookie);
    expect(r.signature.valid).toBe(true);
    expect(r.domain.matches).toBe(true);
    expect(r.overall).not.toBe('invalid');
  });

  it('is invalid to anyone outside the session', async () => {
    const r = await verify(payload);
    expect(r.domain.matches).toBe(false);
    expect(r.overall).toBe('invalid');
  });

  it('and a production proof is invalid inside the session', async () => {
    const w = Wallet.createRandom();
    const real = domainFor('mainnet');
    const r = await verify(
      {
        signed: { domain: real, types: EIP712_TYPES, message },
        proof: { signer: w.address, signature: await w.signTypedData(real, EIP712_TYPES, message) },
      },
      cookie
    );
    expect(r.domain.matches).toBe(false);
    expect(r.overall).toBe('invalid');
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { createApp } from '../src/app';
import { Chain, isRpcAuthError } from '../src/wildcat/chain';
import { loadConfig } from '../src/wildcat/config';

/**
 * rpc.wildcat.finance sits behind a bearer gateway: without a token it answers
 * `401 {"error":"unauthorized"}` with `WWW-Authenticate: Bearer realm="wildcat-gateway"` in
 * about 0.1s. This stub behaves the same way, so the token plumbing and the error message can
 * be checked without holding the real credential.
 */
const TOKEN = 'gateway-token-' + 'k'.repeat(20);
const seenAuth: (string | undefined)[] = [];

function gateway(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seenAuth.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        res.setHeader('www-authenticate', 'Bearer realm="wildcat-gateway"');
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      const { id } = JSON.parse(body || '{}');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x18a2f08' }));
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

let gw: Awaited<ReturnType<typeof gateway>>;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  gw = await gateway();
  for (const k of ['RPC_URL', 'RPC_BEARER_TOKEN', 'DEBUG_KEY', 'DEBUG_MODE']) saved[k] = process.env[k];
});

afterAll(async () => {
  await gw.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const withEnv = async <T>(env: Record<string, string | undefined>, fn: () => Promise<T>) => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe('the authenticated RPC gateway', () => {
  it('defaults to the Wildcat gateway', async () => {
    await withEnv({ RPC_URL: undefined }, async () => {
      expect(loadConfig().rpcUrl).toBe('https://rpc.wildcat.finance/');
    });
  });

  it('sends the bearer token on every request when one is configured', async () => {
    await withEnv({ RPC_URL: gw.url, RPC_BEARER_TOKEN: TOKEN }, async () => {
      seenAuth.length = 0;
      const chain = new Chain(loadConfig());
      await expect(chain.provider.getBlockNumber()).resolves.toBeTypeOf('number');
      expect(seenAuth).not.toHaveLength(0);
      expect(seenAuth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    });
  });

  it('is rejected without one, and that reads as an auth failure', async () => {
    await withEnv({ RPC_URL: gw.url, RPC_BEARER_TOKEN: undefined }, async () => {
      const chain = new Chain(loadConfig());
      const err = await chain.provider.getBlockNumber().then(
        () => null,
        (e) => e
      );
      expect(err).toBeTruthy();
      expect(isRpcAuthError(err)).toBe(true);
    });
  });

  it('tells the operator the token is missing, not that the node is down', async () => {
    await withEnv(
      { RPC_URL: gw.url, RPC_BEARER_TOKEN: undefined, DEBUG_KEY: undefined, DEBUG_MODE: undefined },
      async () => {
        const server = createServer(createApp());
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const res = await fetch(base + '/markets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ borrower: '0x000000000000000000000000000000000000bEEF' }),
        });
        const text = await res.text();
        await new Promise<void>((r) => server.close(() => r()));
        expect(res.status).toBe(503);
        expect(text).toContain('RPC_BEARER_TOKEN is not set');
        expect(text).not.toContain('not answering');
      }
    );
  });

  it('reports whether it is authenticated in the deep health probe', async () => {
    await withEnv({ RPC_URL: gw.url, RPC_BEARER_TOKEN: TOKEN }, async () => {
      const server = createServer(createApp());
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const h = await (await fetch(base + '/health?deep=1')).json();
      await new Promise<void>((r) => server.close(() => r()));
      expect(h.rpc.authenticated).toBe(true);
      expect(h.rpc.header.ok).toBe(true);
    });
  });
});

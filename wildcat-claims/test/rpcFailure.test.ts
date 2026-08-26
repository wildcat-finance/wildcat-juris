import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { createApp } from '../src/app';
import { Chain, isRpcTransportError } from '../src/wildcat/chain';
import { loadConfig } from '../src/wildcat/config';

/**
 * Reproduces the production failure: a node that answers header methods promptly while every
 * STATE read fails. The live archive node stalled for 20s before its gateway returned 502; the
 * stub answers 502 straight away, which ethers classifies identically (SERVER_ERROR) and keeps
 * the suite fast.
 */
const calls: string[] = [];
function stalledNode(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method } = JSON.parse(body || '{}');
      calls.push(method);
      if (method === 'eth_chainId' || method === 'eth_blockNumber') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x18a2f08' }));
      }
      res.statusCode = 502; // what nginx returned in front of the real node
      res.setHeader('content-type', 'text/html');
      res.end('<html><head><title>502 Bad Gateway</title></head></html>');
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

let node: Awaited<ReturnType<typeof stalledNode>>;
let server: Server;
let base: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  node = await stalledNode();
  for (const k of ['RPC_URL', 'DEBUG_KEY', 'DEBUG_MODE']) saved[k] = process.env[k];
  process.env.RPC_URL = node.url;
  delete process.env.DEBUG_KEY;
  delete process.env.DEBUG_MODE;
  server = createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await node.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('classifying an RPC failure', () => {
  it('separates the endpoint failing from the contract answering unusably', () => {
    for (const code of ['TIMEOUT', 'SERVER_ERROR', 'NETWORK_ERROR', 'CANCELLED']) {
      expect(isRpcTransportError({ code })).toBe(true);
    }
    for (const code of ['CALL_EXCEPTION', 'BAD_DATA', 'UNSUPPORTED_OPERATION', 'INVALID_ARGUMENT']) {
      expect(isRpcTransportError({ code })).toBe(false);
    }
    expect(isRpcTransportError(null)).toBe(false);
    expect(isRpcTransportError(new Error('plain'))).toBe(false);
  });
});

describe('a stalled node fails fast instead of consuming the function budget', () => {
  it('bounds every request well under the 30s maxDuration', () => {
    const cfg = loadConfig();
    expect(cfg.rpcTimeoutMs).toBeLessThan(30_000);
    expect(cfg.rpcTimeoutMs).toBeGreaterThanOrEqual(1_000);
  });

  it('does not retry the registry read through the paged fallback', async () => {
    const chain = new Chain({ ...loadConfig(), rpcUrl: node.url });
    calls.length = 0;
    await expect(chain.getAllMarkets()).rejects.toThrow();
    // One attempt only. Retrying a transport failure is what turned a 20s RPC error into a
    // 40s serverless timeout, since the fallback stalls exactly as long as the primary.
    expect(calls.filter((m) => m === 'eth_call')).toHaveLength(1);
  });

  it('tells the caller the node is down, with a 503 rather than a bare 500', async () => {
    const res = await fetch(base + '/markets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ borrower: '0x000000000000000000000000000000000000bEEF' }),
    });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('Ethereum node is not answering');
    expect(text).toContain('RPC_URL');
  });

  it('does the same for an eligibility check', async () => {
    const res = await fetch(base + '/eligibility', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: '0x000000000000000000000000000000000000bEEF',
        market: '0x000000000000000000000000000000000000bEEF',
      }),
    });
    expect(res.status).toBe(503);
  });
});

describe('/health?deep=1 names which half of the node is broken', () => {
  it('shallow health stays exactly as documented', async () => {
    expect(await (await fetch(base + '/health')).json()).toEqual({ ok: true, network: 'mainnet' });
  });

  it('reports the header read passing and the state read failing', async () => {
    const h = await (await fetch(base + '/health?deep=1')).json();
    expect(h.ok).toBe(false);
    expect(h.rpc.header.ok).toBe(true); // eth_blockNumber answers…
    expect(h.rpc.state.ok).toBe(false); // …while state access does not
    expect(String(h.rpc.state.error)).toBeTruthy();
    expect(h.rpc.timeoutMs).toBe(loadConfig().rpcTimeoutMs);
  });
});

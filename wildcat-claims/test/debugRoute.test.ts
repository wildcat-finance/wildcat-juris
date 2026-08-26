import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { createApp } from '../src/app';
import { DEBUG_COOKIE } from '../src/debugSession';
import { DEBUG_DOMAIN_NAME } from '../src/utils';

const KEY = 'test-debug-key-' + 'z'.repeat(24);

/** Serve the real app on an ephemeral port. /config and /debug/session touch no chain. */
async function serve(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const server = createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

const open = (base: string, body: unknown) =>
  fetch(base + '/debug/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('debug session over HTTP, with a key deployed', () => {
  let app: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    app = await serve({ DEBUG_KEY: KEY, DEBUG_MODE: undefined });
  });
  afterAll(() => app.stop());

  it('an ordinary visitor sees honest config and the production domain', async () => {
    const cfg = await (await fetch(app.base + '/config')).json();
    expect(cfg.debug).toBe(false);
    expect(cfg.domain.name).toBe('Wildcat Claims');
  });

  it('the right key returns a session cookie', async () => {
    const res = await open(app.base, { key: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ debug: true });
    expect(res.headers.get('set-cookie') ?? '').toContain(`${DEBUG_COOKIE}=`);
  });

  it('presenting that cookie flips config to debug and to the debug domain', async () => {
    const cookie = (await open(app.base, { key: KEY })).headers.get('set-cookie')!.split(';')[0];
    const cfg = await (await fetch(app.base + '/config', { headers: { cookie } })).json();
    expect(cfg.debug).toBe(true);
    expect(cfg.domain.name).toBe(DEBUG_DOMAIN_NAME);
  });

  it('leaves everyone else honest while that session is open', async () => {
    await open(app.base, { key: KEY });
    const cfg = await (await fetch(app.base + '/config')).json();
    expect(cfg.debug).toBe(false);
  });

  it('a wrong key is indistinguishable from a route that does not exist', async () => {
    const res = await open(app.base, { key: 'wrong-' + 'z'.repeat(30) });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a forged cookie does not open a session', async () => {
    const cfg = await (
      await fetch(app.base + '/config', {
        headers: { cookie: `${DEBUG_COOKIE}=${Date.now() + 3_600_000}.deadbeef` },
      })
    ).json();
    expect(cfg.debug).toBe(false);
  });

  it('ending the session clears the cookie', async () => {
    const res = await open(app.base, { end: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ debug: false });
    expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });
});

describe('debug session with no key deployed (production default)', () => {
  let app: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    app = await serve({ DEBUG_KEY: undefined, DEBUG_MODE: undefined });
  });
  afterAll(() => app.stop());

  it('404s whatever is posted, revealing nothing about the deployment', async () => {
    for (const body of [{ key: KEY }, { end: true }, {}]) {
      expect((await open(app.base, body)).status).toBe(404);
    }
  });

  it('a key too short to be worth guessing is ignored', async () => {
    const short = await serve({ DEBUG_KEY: 'short-key', DEBUG_MODE: undefined });
    expect((await open(short.base, { key: 'short-key' })).status).toBe(404);
    await short.stop();
  });
});

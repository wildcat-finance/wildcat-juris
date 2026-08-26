import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The page had a debug-only box that set `account` to a typed address without setting a
 * `provider`. It wrote to the same element a real connection writes to, so it looked like a
 * wallet had been connected, and then signing was impossible: with no provider the page refused
 * outright, and with a provider from a genuine connection the signature recovered to the wrong
 * address and /submit rejected it. Its own caption promised "you still sign with your own wallet",
 * which the flow cannot do — /submit verifies the signature authorizes the claimed account.
 *
 * The invariant that keeps that from coming back: an account is only ever adopted together with
 * the provider that can sign for it.
 */
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'app-build', 'index.html'), 'utf8');

describe('connecting a wallet', () => {
  it('has no debug address box', () => {
    for (const id of ['debugAddr', 'debugUseBtn', 'debugBox']) {
      expect(indexHtml).not.toContain(id);
    }
  });

  it('adopts an account only where a provider is set too', () => {
    const lines = indexHtml.split('\n');
    const accountSets = lines
      .map((l, i) => ({ l: l.trim(), i }))
      .filter((x) => /^account = /.test(x.l));
    // Exactly two: the injected-wallet connect, and the Safe App auto-connect.
    expect(accountSets).toHaveLength(2);
    for (const { i } of accountSets) {
      const near = lines.slice(Math.max(0, i - 6), i + 2).join('\n');
      expect(near).toMatch(/provider = new BrowserProvider\(/);
    }
  });

  it('still refuses to sign without a provider', () => {
    expect(indexHtml).toContain('Connect a wallet or Safe first.');
  });

  it('tells a debug session to connect its own wallet', () => {
    const banner = indexHtml.match(/id="debugBanner"[^>]*>([\s\S]*?)<\/div>/)![1];
    expect(banner).toMatch(/connect your own wallet/i);
    expect(banner).toMatch(/#dbg=off/);
  });
});

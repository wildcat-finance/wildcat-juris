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

function between(start: string, end: string): string {
  const from = indexHtml.indexOf(start);
  const to = indexHtml.indexOf(end, from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return indexHtml.slice(from, to);
}

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
    expect(banner).toMatch(/connect an EOA or Safe/i);
    expect(banner).toMatch(/#dbg=off/);
  });

  it('does not let a top-level extension response impersonate a Safe', () => {
    const safeConnect = between('async function trySafeApp()', '// ---- 3 · eligibility');
    const frameGuard = safeConnect.indexOf('if (window.self === window.top) return;');
    const safeHandshake = safeConnect.indexOf('const sdk = new SafeAppsSDK();');

    expect(frameGuard).toBeGreaterThanOrEqual(0);
    expect(frameGuard).toBeLessThan(safeHandshake);
  });

  it('shows the user what the injected wallet is waiting for', () => {
    const connect = between('$("connectBtn").addEventListener', '// When opened inside Safe{Wallet}');
    const waitingStatus = connect.indexOf('Waiting for wallet approval');
    const accountRequest = connect.indexOf('eth_requestAccounts');

    expect(connect).toContain('walletConnectPending');
    expect(connect).toMatch(/already pending/i);
    expect(connect).toMatch(/Unlock MetaMask/);
    expect(connect).toMatch(/permission to run on this site/);
    expect(waitingStatus).toBeGreaterThanOrEqual(0);
    expect(waitingStatus).toBeLessThan(accountRequest);
  });

  it('recognises a MetaMask rejection wrapped by ethers', () => {
    const connect = between('$("connectBtn").addEventListener', '// When opened inside Safe{Wallet}');

    expect(connect).toContain('e.info?.error?.code ?? e.error?.code ?? e.code');
    expect(connect).toContain('code === "ACTION_REJECTED"');
  });
});

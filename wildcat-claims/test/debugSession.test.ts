import { describe, it, expect } from 'vitest';
import {
  DEBUG_COOKIE,
  DEBUG_TTL_MS,
  clearDebugCookieHeader,
  debugCookieHeader,
  mintDebugToken,
  parseCookies,
  secretEquals,
  verifyDebugToken,
} from '../src/debugSession';
import {
  DEBUG_DOMAIN_NAME,
  DEBUG_SIGNATURE_BANNER,
  claimDigest,
  domainFor,
  toSignatureString,
  type FormData,
  type SignedClaimContext,
} from '../src/utils';

const KEY = 'k'.repeat(32);
const NOW = 1_800_000_000_000;

describe('debug-session tokens', () => {
  it('accepts a token it minted, inside its lifetime', () => {
    const t = mintDebugToken(KEY, NOW);
    expect(verifyDebugToken(KEY, t, NOW)).toBe(true);
    expect(verifyDebugToken(KEY, t, NOW + DEBUG_TTL_MS - 1)).toBe(true);
  });

  it('rejects the token once its lifetime has run out', () => {
    const t = mintDebugToken(KEY, NOW);
    expect(verifyDebugToken(KEY, t, NOW + DEBUG_TTL_MS)).toBe(false);
    expect(verifyDebugToken(KEY, t, NOW + DEBUG_TTL_MS + 1)).toBe(false);
  });

  it('rejects another key’s token', () => {
    expect(verifyDebugToken('j'.repeat(32), mintDebugToken(KEY, NOW), NOW)).toBe(false);
  });

  it('rejects an extended expiry: the HMAC covers it', () => {
    const [exp, mac] = mintDebugToken(KEY, NOW).split('.');
    const stretched = `${Number(exp) + DEBUG_TTL_MS}.${mac}`;
    expect(verifyDebugToken(KEY, stretched, NOW)).toBe(false);
  });

  it('rejects a missing, empty or malformed token, and a missing key', () => {
    for (const t of [undefined, '', '.', 'nodot', 'abc.def', `${NOW + 1}.`]) {
      expect(verifyDebugToken(KEY, t, NOW)).toBe(false);
    }
    expect(verifyDebugToken('', mintDebugToken(KEY, NOW), NOW)).toBe(false);
  });

  it('compares secrets of differing length without throwing', () => {
    expect(secretEquals(KEY, KEY)).toBe(true);
    expect(secretEquals(KEY, 'short')).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });
});

describe('debug-session cookies', () => {
  it('sets a script-invisible, same-site cookie, Secure only over https', () => {
    const h = debugCookieHeader(mintDebugToken(KEY, NOW), true);
    expect(h).toContain(`${DEBUG_COOKIE}=`);
    expect(h).toContain('HttpOnly');
    expect(h).toContain('SameSite=Strict');
    expect(h).toContain('Secure');
    expect(debugCookieHeader('t', false)).not.toContain('Secure');
    expect(clearDebugCookieHeader(true)).toContain('Max-Age=0');
  });

  it('reads the cookie back out of a header carrying other cookies', () => {
    const t = mintDebugToken(KEY, NOW);
    const jar = parseCookies(`other=1; ${DEBUG_COOKIE}=${t}; trailing=x`);
    expect(jar[DEBUG_COOKIE]).toBe(t);
    expect(verifyDebugToken(KEY, jar[DEBUG_COOKIE], NOW)).toBe(true);
  });

  it('returns nothing for a missing or malformed header', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('=novalue; ;; junk')).toEqual({});
  });
});

const form: FormData = {
  name: 'Test Lender',
  email: 'lender@example.com',
  other: '',
  country: 'GB',
  acceptTerms: true,
  acceptUndertaking: true,
};

const claim: SignedClaimContext = {
  network: 'mainnet',
  market: '0x1234567890123456789012345678901234567890',
  penalizedDays: 91,
  amountOwedWei: '100000000000000000000',
  asOfBlock: 20_000_000,
};

describe('a dry run cannot be passed off as a real claim', () => {
  it('signs under its own EIP-712 domain, same chain', () => {
    const real = domainFor('mainnet');
    const dbg = domainFor('mainnet', true);
    expect(real.name).toBe('Wildcat Claims');
    expect(dbg.name).toBe(DEBUG_DOMAIN_NAME);
    expect(dbg.chainId).toBe(real.chainId);
    expect(dbg.version).toBe(real.version);
  });

  it('produces a different digest, so a debug signature fails production verification', () => {
    const real = claimDigest(form, claim, '0xsig', false);
    const dbg = claimDigest(form, claim, '0xsig', true);
    expect(dbg).not.toBe(real);
  });

  it('marks the personal_sign text too, which carries no domain', () => {
    const real = toSignatureString(form, claim);
    const dbg = toSignatureString(form, claim, true);
    expect(real).not.toContain(DEBUG_SIGNATURE_BANNER);
    expect(dbg.startsWith(DEBUG_SIGNATURE_BANNER)).toBe(true);
    expect(claimDigest(form, claim, 'personal_sign_0xsig', true)).not.toBe(
      claimDigest(form, claim, 'personal_sign_0xsig', false)
    );
  });

  it('leaves a production claim byte-for-byte unchanged', () => {
    expect(toSignatureString(form, claim, false)).toBe(toSignatureString(form, claim));
    expect(claimDigest(form, claim, '0xsig', false)).toBe(claimDigest(form, claim, '0xsig'));
  });
});

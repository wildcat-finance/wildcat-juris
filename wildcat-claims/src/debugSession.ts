import { createHmac, timingSafeEqual, createHash } from 'crypto';

/**
 * Per-browser debug sessions.
 *
 * DEBUG_MODE is process-wide: switching it on fakes eligibility for *every* visitor, so it
 * can never be used on the hosted site. A debug session is the same fudge scoped to one
 * browser, so the team can dry-run the whole claim flow against production while ordinary
 * visitors keep seeing honest reads.
 *
 * Activation is deliberately unadvertised. The operator opens the normal page with the shared
 * secret in the URL *fragment* (`/#dbg=<DEBUG_KEY>`); fragments are never sent to the server,
 * so the secret stays out of access logs, `Referer` headers and proxy caches. The page posts it
 * once to /debug/session, receives the cookie below, and strips the fragment. Nothing about
 * the page or its routes hints that any of this exists: with DEBUG_KEY unset, /debug/session
 * 404s exactly like a path that was never registered.
 */

/** Session cookie. Opaque name — it should not read as an invitation. */
export const DEBUG_COOKIE = 'jw_s';

/** How long one activation lasts. Short enough that a leaked cookie stops working. */
export const DEBUG_TTL_MS = 12 * 60 * 60 * 1000;

/** Compare two secrets without leaking their contents or length through timing. */
export function secretEquals(a: string, b: string): boolean {
  // Hash first: timingSafeEqual throws on length mismatch, which would itself leak length.
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Mint a session token: `<expiry-ms>.<hmac>`. Self-contained and stateless — the expiry is
 * covered by the HMAC, so a serverless function holds no session store and cannot be tricked
 * into extending one. `now` is injectable for tests.
 */
export function mintDebugToken(key: string, now: number, ttlMs: number = DEBUG_TTL_MS): string {
  const exp = now + ttlMs;
  return `${exp}.${sign(key, exp)}`;
}

/** True only for a token this key minted that has not expired. */
export function verifyDebugToken(key: string, token: string | undefined, now: number): boolean {
  if (!key || !token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(exp) || exp <= now) return false;
  return secretEquals(token.slice(dot + 1), sign(key, exp));
}

const sign = (key: string, exp: number): string =>
  createHmac('sha256', key).update(`jw-debug-v1:${exp}`).digest('hex');

/** Parse a Cookie header. Returns {} for a missing or malformed header. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** `Set-Cookie` value for an activation. Host-only, script-invisible, not sent cross-site. */
export function debugCookieHeader(token: string, secure: boolean): string {
  const attrs = [
    `${DEBUG_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(DEBUG_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** `Set-Cookie` value that clears an activation. */
export function clearDebugCookieHeader(secure: boolean): string {
  const attrs = [`${DEBUG_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

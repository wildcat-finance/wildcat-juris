import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { getAddress } from 'ethers';

import { loadConfig } from './wildcat/config';
import { Chain } from './wildcat/chain';
import { Eligibility } from './wildcat/eligibility';
import { verifyProof } from './verifyProof';
import {
  getFormDataError,
  verifySignature,
  claimDigest,
  chainIdFor,
  domainFor,
  QUALIFYING_LENDER_UNDERTAKING,
  QUALIFYING_LENDER_DEFINITION_LIST,
  QUALIFYING_LENDER_AGREEMENT,
  QUALIFYING_LENDER_AGREEMENT_SHA256,
  type SubmitData,
} from './utils';
import {
  DEBUG_COOKIE,
  clearDebugCookieHeader,
  debugCookieHeader,
  mintDebugToken,
  parseCookies,
  secretEquals,
  verifyDebugToken,
} from './debugSession';

function asAddress(v: unknown): string | null {
  try {
    return typeof v === 'string' ? getAddress(v) : null;
  } catch {
    return null;
  }
}

/**
 * Load the single-page frontend once. The file lives in app-build/; resolve it from a few
 * candidate locations so it works under local `dist/`, `ts-node`, and a bundled serverless
 * function (where it is shipped via vercel.json `includeFiles`).
 */
function loadIndexHtml(): string | null {
  const candidates = [
    path.join(__dirname, '..', 'app-build', 'index.html'),
    path.join(process.cwd(), 'app-build', 'index.html'),
    path.join(__dirname, 'app-build', 'index.html'),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Build the Express app (routes + single-page frontend). No `listen()` — the caller decides
 * how to serve it (local HTTP/HTTPS in index.ts, or a serverless handler in api/index.ts).
 */
export function createApp(): Express {
  const cfg = loadConfig();
  const chain = new Chain(cfg);
  const eligibility = new Eligibility(chain, cfg);

  if (cfg.debugMode) {
    console.warn(
      '⚠  DEBUG_MODE is ON — any lender is assumed to hold >=100 underlying in every market. ' +
        'For testing the signing flow only; NEVER enable in production.'
    );
  }

  /**
   * Is this request a debug one? True for the process-wide DEBUG_MODE (local development) or
   * for a browser holding a live debug-session cookie. Every handler asks per request, so a
   * dry run never changes what anyone else sees.
   */
  const isDebug = (req: Request): boolean =>
    cfg.debugMode ||
    (!!cfg.debugKey &&
      verifyDebugToken(cfg.debugKey, parseCookies(req.headers.cookie)[DEBUG_COOKIE], Date.now()));

  /** Vercel terminates TLS upstream, so trust the forwarded scheme for the Secure attribute. */
  const isHttps = (req: Request): boolean =>
    req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, network: cfg.network }));

  // Public config the frontend needs to render context and build EIP-712 typed data.
  app.get('/config', (req: Request, res: Response) =>
    res.json({
      network: cfg.network,
      chainId: chainIdFor(cfg.network),
      borrower: cfg.borrower ?? null,
      defaultBufferDays: Math.round(cfg.defaultBufferSec / 86_400),
      // Debug sessions get their own domain, so the page signs, and /submit verifies, under a
      // name that cannot be mistaken for a real claim. See DEBUG_DOMAIN_NAME.
      domain: domainFor(cfg.network, isDebug(req)),
      // The undertaking a lender gives, its definitions, the canonical document they form, and
      // that document's SHA-256 — the value bound into the signature. Published so any client can
      // render the exact wording and any verifier can recompute the digest.
      undertaking: QUALIFYING_LENDER_UNDERTAKING,
      undertakingDefinitions: QUALIFYING_LENDER_DEFINITION_LIST,
      undertakingAgreement: QUALIFYING_LENDER_AGREEMENT,
      undertakingSha256: QUALIFYING_LENDER_AGREEMENT_SHA256,
      debug: isDebug(req),
    })
  );

  // Discover a borrower's markets (with names + live default status) for selection.
  app.post('/markets', async (req: Request, res: Response) => {
    const borrower = asAddress((req.body ?? {}).borrower);
    if (!borrower) return res.status(400).send('Invalid borrower address');
    try {
      return res.json({ borrower, markets: await eligibility.getBorrowerMarkets(borrower) });
    } catch (err: any) {
      console.error(`/markets ${borrower}:`, err.message);
      return res.status(500).send('Failed to load borrower markets');
    }
  });

  // Check one lender against one market; returns the canonical claim context to sign.
  app.post('/eligibility', async (req: Request, res: Response) => {
    const { account: rawAccount, market: rawMarket } = req.body ?? {};
    const account = asAddress(rawAccount);
    const market = asAddress(rawMarket);
    if (!account) return res.status(400).send('Invalid account address');
    if (!market) return res.status(400).send('Invalid market address');
    try {
      const debug = isDebug(req);
      const result = await eligibility.eligibleClaim(account, market, debug);
      return res.json({
        ...result,
        claim: {
          network: cfg.network,
          market,
          penalizedDays: result.penalizedDays,
          amountOwedWei: result.amountOwedWei,
          asOfBlock: result.asOfBlock,
        },
        debug,
      });
    } catch (err: any) {
      console.error(`/eligibility ${account}/${market}:`, err.message);
      return res.status(500).send('Failed to compute eligibility');
    }
  });

  // Submit a signed claim: verify, re-check eligibility live, return a copyable proof.
  app.post('/submit', async (req: Request, res: Response) => {
    const { account: rawAccount, data, signature } = (req.body ?? {}) as {
      account?: string;
      data?: SubmitData;
      signature?: string;
    };
    if (!data?.form || !data?.claim || typeof signature !== 'string') {
      return res.status(400).send('Malformed submission');
    }

    const formError = getFormDataError(data.form);
    if (formError) return res.status(400).send(formError);

    if (data.claim.network !== cfg.network) return res.status(409).send('Wrong network');
    const market = asAddress(data.claim.market);
    if (!market) return res.status(400).send('Invalid market address');
    const lender = asAddress(rawAccount);
    if (!lender) return res.status(400).send('Invalid account address');

    // Verify the signature authorizes `lender`. EOAs are checked by ECDSA recovery; smart-
    // contract wallets (e.g. a Safe multisig) are checked via EIP-1271 isValidSignature. Either
    // way the signature proves control of `lender` — we never trust a bare client-supplied address.
    const debug = isDebug(req);
    let valid = false;
    try {
      if (await chain.isContract(lender)) {
        valid = await chain.isValidErc1271(
          lender,
          claimDigest(data.form, data.claim, signature, debug),
          signature
        );
      } else {
        valid =
          verifySignature(data.form, data.claim, signature, debug).toLowerCase() ===
          lender.toLowerCase();
      }
    } catch {
      valid = false;
    }
    if (!valid) return res.status(400).send('Invalid signature');

    // Server-side re-check (live): never trust client-supplied eligibility.
    let result;
    try {
      result = await eligibility.eligibleClaim(lender, market, debug);
    } catch (err: any) {
      console.error('/submit eligibility check:', err.message);
      return res.status(500).send('Failed to verify eligibility');
    }
    if (!result.eligible) {
      return res.status(400).send('No eligible position for this address in this market');
    }

    // No persistence: the signed claim is verified and returned as a copyable proof.
    return res.json({
      ok: true,
      market,
      lender,
      amountOwedWei: data.claim.amountOwedWei,
      penalizedDays: data.claim.penalizedDays,
      asOfBlock: data.claim.asOfBlock,
      submittedAt: new Date().toISOString(),
      debug,
    });
  });

  // Open or close a debug session for this browser. The page posts the shared secret here once,
  // having picked it up from the URL fragment (never sent to a server, so it stays out of access
  // logs and Referer headers) and stripped it. With DEBUG_KEY unset this 404s, and a wrong key
  // 404s identically: nothing distinguishes the route from one that was never registered, and
  // nothing tells a prober whether the deployment has a key at all.
  app.post('/debug/session', (req: Request, res: Response) => {
    if (!cfg.debugKey) return res.status(404).send('Not found');

    if ((req.body ?? {}).end === true) {
      res.setHeader('Set-Cookie', clearDebugCookieHeader(isHttps(req)));
      return res.json({ debug: false });
    }

    const key = (req.body ?? {}).key;
    if (typeof key !== 'string' || !secretEquals(key, cfg.debugKey)) {
      return res.status(404).send('Not found');
    }
    res.setHeader('Set-Cookie', debugCookieHeader(mintDebugToken(cfg.debugKey, Date.now()), isHttps(req)));
    return res.json({ debug: true });
  });

  // Independently verify a produced proof (for the Wildcat Foundation). The implementation
  // lives in src/verifyProof.ts so this route and scripts/demo-server.js share one copy —
  // they drifted apart when each held its own, and the verifier ended up stricter than the
  // issuer. See that file for what each layer establishes.
  //
  // The session's debug flag goes with it: a dry run must be checkable end to end, and a
  // dry-run proof must still read as invalid to anyone outside that session.
  app.post('/verify', async (req: Request, res: Response) => {
    const out = await verifyProof(
      { cfg, chain, eligibility, debug: isDebug(req) },
      req.body
    );
    return out.status === 200 ? res.json(out.body) : res.status(400).send(out.error);
  });

  // Safe App manifest + icon — lets Safe{Wallet} load this as a Custom App so a Safe lender
  // can open it from inside their Safe and sign with their owners (EIP-1271).
  app.get('/manifest.json', (_req, res) =>
    res.json({
      name: 'Wildcat Lender Claim',
      description:
        'Prove you are an impacted lender in a defaulted Wildcat market and generate a signed eligibility proof for the Wildcat Foundation.',
      iconPath: 'icon.svg',
    })
  );
  app.get('/icon.svg', (_req, res) =>
    res
      .type('image/svg+xml')
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0e0f13"/><text x="32" y="44" font-family="system-ui,sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="#f0b429">W</text></svg>'
      )
  );

  // Single-page frontend for everything else (the page is one self-contained HTML file).
  const indexHtml = loadIndexHtml();
  app.get('*', (_req, res) =>
    indexHtml ? res.type('html').send(indexHtml) : res.status(404).send('frontend not built')
  );

  return app;
}

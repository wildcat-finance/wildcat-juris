import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { getAddress } from 'ethers';

import { loadConfig } from './wildcat/config';
import { Chain } from './wildcat/chain';
import { Eligibility } from './wildcat/eligibility';
import {
  getFormDataError,
  verifySignature,
  chainIdFor,
  domainFor,
  type SubmitData,
} from './utils';

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

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, network: cfg.network }));

  // Public config the frontend needs to render context and build EIP-712 typed data.
  app.get('/config', (_req, res) =>
    res.json({
      network: cfg.network,
      chainId: chainIdFor(cfg.network),
      borrower: cfg.borrower ?? null,
      defaultBufferDays: Math.round(cfg.defaultBufferSec / 86_400),
      domain: domainFor(cfg.network),
      debug: cfg.debugMode,
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
      const result = await eligibility.eligibleClaim(account, market);
      return res.json({
        ...result,
        claim: {
          network: cfg.network,
          market,
          penalizedDays: result.penalizedDays,
          amountOwedWei: result.amountOwedWei,
          asOfBlock: result.asOfBlock,
        },
        debug: cfg.debugMode,
      });
    } catch (err: any) {
      console.error(`/eligibility ${account}/${market}:`, err.message);
      return res.status(500).send('Failed to compute eligibility');
    }
  });

  // Submit a signed claim: verify, re-check eligibility live, return a copyable proof.
  app.post('/submit', async (req: Request, res: Response) => {
    const { data, signature } = (req.body ?? {}) as { data?: SubmitData; signature?: string };
    if (!data?.form || !data?.claim || typeof signature !== 'string') {
      return res.status(400).send('Malformed submission');
    }

    const formError = getFormDataError(data.form);
    if (formError) return res.status(400).send(formError);

    if (data.claim.network !== cfg.network) return res.status(409).send('Wrong network');
    const market = asAddress(data.claim.market);
    if (!market) return res.status(400).send('Invalid market address');

    // Recover signer.
    let address: string;
    try {
      address = verifySignature(data.form, data.claim, signature);
    } catch {
      return res.status(400).send('Invalid signature');
    }

    // Server-side re-check (live): never trust client-supplied eligibility.
    let result;
    try {
      result = await eligibility.eligibleClaim(address, market);
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
      lender: address,
      amountOwedWei: data.claim.amountOwedWei,
      penalizedDays: data.claim.penalizedDays,
      asOfBlock: data.claim.asOfBlock,
      submittedAt: new Date().toISOString(),
      debug: cfg.debugMode,
    });
  });

  // Single-page frontend for everything else (the page is one self-contained HTML file).
  const indexHtml = loadIndexHtml();
  app.get('*', (_req, res) =>
    indexHtml ? res.type('html').send(indexHtml) : res.status(404).send('frontend not built')
  );

  return app;
}

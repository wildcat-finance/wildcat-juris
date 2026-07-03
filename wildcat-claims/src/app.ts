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
  claimDigest,
  chainIdFor,
  domainFor,
  type SubmitData,
} from './utils';
import { verifyProof, NetworkMismatchError, type ProofBundle } from './verify';

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
    let valid = false;
    try {
      if (await chain.isContract(lender)) {
        valid = await chain.isValidErc1271(lender, claimDigest(data.form, data.claim, signature), signature);
      } else {
        valid = verifySignature(data.form, data.claim, signature).toLowerCase() === lender.toLowerCase();
      }
    } catch {
      valid = false;
    }
    if (!valid) return res.status(400).send('Invalid signature');

    // Server-side re-check (live): never trust client-supplied eligibility.
    let result;
    try {
      result = await eligibility.eligibleClaim(lender, market);
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
      debug: cfg.debugMode,
    });
  });

  // Independently verify a proof (the flow the Foundation runs on a received proof). Re-checks the
  // signature and replays the committed figures at the claim's block; DEBUG is forced off inside
  // verifyProof, so this is meaningful even on a debug deployment. Reads nothing client-supplied
  // as trusted — the address is taken from the signature/receipt and re-derived on chain.
  app.post('/verify', async (req: Request, res: Response) => {
    const bundle = (req.body ?? {}) as Partial<ProofBundle>;
    if (!bundle.payload?.message || typeof bundle.proof?.signature !== 'string') {
      return res.status(400).send('Malformed proof bundle — expected { payload, proof }.');
    }
    try {
      return res.json(await verifyProof(bundle as ProofBundle, cfg));
    } catch (err: any) {
      if (err instanceof NetworkMismatchError) return res.status(409).send(err.message);
      console.error('/verify:', err.message);
      return res.status(400).send('Could not verify proof');
    }
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

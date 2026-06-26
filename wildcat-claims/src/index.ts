import express, { type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { getAddress } from 'ethers';

import { loadConfig } from './wildcat/config';
import { Chain } from './wildcat/chain';
import { Eligibility } from './wildcat/eligibility';
import {
  getFormDataError,
  verifySignature,
  chainIdFor,
  domainFor,
  toAccount,
  type SubmitData,
} from './utils';
import database from './database';
import { Sheets } from './sheets';

function asAddress(v: unknown): string | null {
  try {
    return typeof v === 'string' ? getAddress(v) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const chain = new Chain(cfg);
  const eligibility = new Eligibility(chain, cfg);

  if (cfg.debugMode) {
    console.warn(
      '⚠  DEBUG_MODE is ON — any lender is assumed to hold >=100 underlying in every market. ' +
        'For testing the signing flow only; NEVER enable in production.'
    );
  }

  // Optional Google Sheets mirror (skipped if .google.json is absent).
  let sheets: Sheets | undefined;
  const googleCredsPath = path.join(__dirname, '..', '.google.json');
  if (fs.existsSync(googleCredsPath)) {
    const creds = JSON.parse(fs.readFileSync(googleCredsPath, 'utf8'));
    sheets = new Sheets(creds.sheet_id, creds.client_email, creds.private_key);
    await sheets.connect();
    console.log('Connected to Google Sheet.');
  } else {
    console.warn('.google.json not found — sheet mirroring disabled.');
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

  // Submit a signed claim.
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
      // In debug mode the in-default requirement is relaxed, so distinguish the reason.
      const reason =
        !cfg.debugMode && !result.inDefault
          ? 'Market is not in default'
          : 'No eligible position for this address in this market';
      return res.status(400).send(reason);
    }

    const submittedAt = new Date().toISOString();
    const account = toAccount(address, data.form, data.claim, signature, result, submittedAt);

    try {
      await database.putAccount(account);
    } catch (err: any) {
      console.error('/submit db write:', err.message);
      return res.status(500).send('Failed to persist claim');
    }

    if (sheets) {
      try {
        await sheets.addAccount(account);
      } catch (err: any) {
        // Sheet is a mirror; the claim is already durably stored in the DB.
        console.error('/submit sheet write (non-fatal):', err.message);
      }
    }

    return res.json({
      ok: true,
      market,
      lender: address,
      amountOwedWei: data.claim.amountOwedWei,
      penalizedDays: data.claim.penalizedDays,
      asOfBlock: data.claim.asOfBlock,
      submittedAt,
      debug: cfg.debugMode,
    });
  });

  // Optionally serve a built frontend if present.
  const appRootPath = path.join(__dirname, '..', 'app-build');
  if (fs.existsSync(appRootPath)) {
    app.use(express.static(appRootPath));
    app.get('*', (_req, res) => res.sendFile(path.join(appRootPath, 'index.html')));
  }

  const PROD = process.env.MODE === 'production';
  const PORT = PROD ? 443 : Number(process.env.PORT ?? 3001);

  if (PROD && PORT === 443) {
    const base = '/etc/letsencrypt/live/claims.wildcat.finance';
    const credentials = {
      key: fs.readFileSync(`${base}/privkey.pem`, 'utf8'),
      cert: fs.readFileSync(`${base}/cert.pem`, 'utf8'),
      ca: fs.readFileSync(`${base}/chain.pem`, 'utf8'),
    };
    https.createServer(credentials, app).listen(PORT, () => console.log(`listening on ${PORT} (https)`));
    const { startRedirectServer } = await import('./httpRedirect');
    startRedirectServer();
  } else {
    app.listen(PORT, () => console.log(`listening on ${PORT} (http) — network=${cfg.network}`));
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

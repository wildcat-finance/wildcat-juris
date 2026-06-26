import express, { type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import https from 'https';

import { loadConfig } from './wildcat/config';
import { Chain } from './wildcat/chain';
import { Eligibility } from './wildcat/eligibility';
import {
  getFormDataError,
  verifySignature,
  computeMarketsHash,
  chainIdFor,
  domainFor,
  toAccount,
  type SubmitData,
} from './utils';
import database from './database';
import { Sheets } from './sheets';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const chain = new Chain(cfg);
  const eligibility = new Eligibility(chain, cfg);

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

  // Resolve the eligibility block + scoped market set up front so the first request is fast.
  await Promise.all([
    chain.resolveEligibilityBlock().then((b) => console.log(`Eligibility block: ${b}`)),
    eligibility.getScopedMarkets(true).then((m) => console.log(`Scoped markets: ${m.length}`)),
  ]).catch((e) => console.error('Startup priming failed:', e.message));

  const signedTimestamp = cfg.eligibilityTimestamp ?? 0;

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, network: cfg.network }));

  // Public config the frontend needs to render context and build EIP-712 typed data.
  app.get('/config', async (_req, res) => {
    return res.json({
      network: cfg.network,
      chainId: chainIdFor(cfg.network),
      incidentId: cfg.incidentId,
      eligibilityTimestamp: signedTimestamp,
      scopedMarkets: await eligibility.getScopedMarkets(),
      domain: domainFor(cfg.network),
    });
  });

  // Pre-check: which scoped markets did this account hold debt in at the threshold?
  // Returns the canonical claim context the client must sign verbatim.
  app.post('/eligibility', async (req: Request, res: Response) => {
    const { account } = req.body ?? {};
    if (typeof account !== 'string') return res.status(400).send('Missing account');
    try {
      const result = await eligibility.eligibleClaims(account);
      const marketsHash = computeMarketsHash(result.claims.map((c) => c.market));
      return res.json({
        ...result,
        chainId: chainIdFor(cfg.network),
        incidentId: cfg.incidentId,
        claim: { network: cfg.network, eligibilityTimestamp: signedTimestamp, marketsHash },
      });
    } catch (err: any) {
      console.error(`/eligibility ${account}:`, err.message);
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

    // The signed context must match this deployment's incident scope, not the client's.
    if (data.claim.network !== cfg.network) return res.status(409).send('Wrong network');
    if (Number(data.claim.eligibilityTimestamp) !== signedTimestamp) {
      return res.status(409).send('Stale eligibility threshold — please refresh and re-sign');
    }

    // Recover signer.
    let address: string;
    try {
      address = verifySignature(data.form, data.claim, signature);
    } catch {
      return res.status(400).send('Invalid signature');
    }

    // Server-side re-check: never trust client-supplied eligibility.
    let result;
    try {
      result = await eligibility.eligibleClaims(address);
    } catch (err: any) {
      console.error('/submit eligibility check:', err.message);
      return res.status(500).send('Failed to verify eligibility');
    }
    if (result.claims.length === 0) {
      return res.status(400).send('No eligible claims for this address');
    }

    // The signature must commit to exactly the markets the server found.
    const serverHash = computeMarketsHash(result.claims.map((c) => c.market));
    if (serverHash.toLowerCase() !== data.claim.marketsHash.toLowerCase()) {
      return res.status(409).send('Eligibility changed since signing — please re-sign');
    }

    const account = toAccount(
      address,
      data.form,
      data.claim,
      signature,
      result.claims,
      result.totalOwedWei,
      cfg.incidentId,
      result.blockNumber
    );

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

    return res.json({ ok: true, markets: result.claims.length, totalOwedWei: result.totalOwedWei });
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

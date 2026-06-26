/**
 * Demo harness: runs the REAL Eligibility + signature/verification code paths
 * against a MOCK chain (dummy on-chain data, no RPC). Serves the frontend so you
 * can click through borrower -> market -> connect -> sign -> submit locally.
 *
 *   npm run build && node scripts/demo-server.js   # serves on :3001
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Wallet, getAddress } = require('ethers');

const { Eligibility } = require('../dist/wildcat/eligibility');
const {
  getFormDataError,
  verifySignature,
  toAccount,
  toSignatureString,
  chainIdFor,
  domainFor,
} = require('../dist/utils');

// ---- Dummy config + mock chain -------------------------------------------
const DEMO_BORROWER = getAddress('0x000000000000000000000000000000000000beef');
const DAY = 86_400n;

const cfg = {
  network: 'mainnet',
  rpcUrl: 'mock',
  addresses: { archController: '0xArch', marketLens: '0xLens', hooksFactory: '0xFac', sanctionsSentinel: '' },
  defaultBufferSec: 90 * 86_400,
  borrower: DEMO_BORROWER,
  includeWithdrawals: true,
  minOwedWei: 0n,
  lensMode: 'direct',
  debugMode: true, // demo harness: allow signing non-defaulted markets to exercise the flow
};

// timeDelinquent for an in-default market: grace + 90d + slack.
const DEFAULTED = 3n * DAY + 90n * DAY + 3600n;

const MARKETS = {
  '0x1111111111111111111111111111111111111111': {
    name: 'Bob Labs USDC', asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6,
    isDelinquent: true, timeDelinquent: DEFAULTED, grace: 3n * DAY, owed: 250000n * 10n ** 6n,
  },
  '0x2222222222222222222222222222222222222222': {
    name: 'Bob Labs WETH', asset: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18,
    isDelinquent: false, timeDelinquent: 9n * DAY, grace: 7n * DAY, owed: 40n * 10n ** 18n,
  },
};

const mockChain = {
  async getAllMarkets() { return Object.keys(MARKETS); },
  async getMarketInfo(market) {
    const m = MARKETS[market];
    return { market, borrower: DEMO_BORROWER, name: m.name, asset: getAddress(m.asset), assetSymbol: m.symbol, assetDecimals: m.decimals };
  },
  async getMarketState(market) {
    const m = MARKETS[market];
    return { isClosed: false, isDelinquent: m.isDelinquent, timeDelinquent: m.timeDelinquent, delinquencyGracePeriod: m.grace };
  },
  async readBorrower() { return DEMO_BORROWER; }, // every demo market belongs to DEMO_BORROWER
  async readLenderHeld(market) { return MARKETS[market].owed; }, // any connected wallet sees a position
  async readWithdrawalsOwed() { return 0n; },
  async resolveAsOfBlock() { return 20_500_000; },
};

const eligibility = new Eligibility(mockChain, cfg);
const asAddress = (v) => { try { return typeof v === 'string' ? getAddress(v) : null; } catch { return null; } };

// ---- Server (mirrors src/index.ts) ---------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, network: cfg.network }));
app.get('/config', (_req, res) => res.json({
  network: cfg.network, chainId: chainIdFor(cfg.network), borrower: cfg.borrower,
  defaultBufferDays: Math.round(cfg.defaultBufferSec / 86_400), domain: domainFor(cfg.network), debug: cfg.debugMode,
}));

app.post('/markets', async (req, res) => {
  const borrower = asAddress((req.body || {}).borrower);
  if (!borrower) return res.status(400).send('Invalid borrower address');
  res.json({ borrower, markets: await eligibility.getBorrowerMarkets(borrower) });
});

app.post('/eligibility', async (req, res) => {
  const account = asAddress((req.body || {}).account);
  const market = asAddress((req.body || {}).market);
  if (!account || !market) return res.status(400).send('Invalid account/market');
  const result = await eligibility.eligibleClaim(account, market);
  res.json({ ...result, claim: { network: cfg.network, market, penalizedDays: result.penalizedDays } });
});

app.post('/submit', async (req, res) => {
  const { data, signature } = req.body || {};
  if (!data?.form || !data?.claim || typeof signature !== 'string') return res.status(400).send('Malformed submission');
  const formError = getFormDataError(data.form);
  if (formError) return res.status(400).send(formError);
  const market = asAddress(data.claim.market);
  if (!market) return res.status(400).send('Invalid market address');
  let address;
  try { address = verifySignature(data.form, data.claim, signature); } catch { return res.status(400).send('Invalid signature'); }
  const result = await eligibility.eligibleClaim(address, market);
  if (!result.eligible) return res.status(400).send(result.inDefault ? 'No eligible position' : 'Market is not in default');
  const account = toAccount(address, data.form, data.claim, signature, result);
  res.json({ ok: true, market, totalOwedWei: result.amountOwedWei, storedFor: account.address });
});

// Serve the frontend.
const appRoot = path.join(__dirname, '..', 'app-build');
app.use(express.static(appRoot));
app.get('*', (_req, res) => res.sendFile(path.join(appRoot, 'index.html')));

// Helper: a valid signed submission for the happy-path demo (in-default market).
async function signedSubmission() {
  const wallet = Wallet.createRandom();
  const market = '0x1111111111111111111111111111111111111111';
  const result = await eligibility.eligibleClaim(wallet.address, market);
  const form = { name: 'Jane Lender', email: 'jane@example.com', other: '', country: 'US', acceptTerms: true, willingToSpeakToLEO: false, willingToLitigate: true };
  const claim = { network: 'mainnet', market: getAddress(market), penalizedDays: result.penalizedDays };
  const sig = await wallet.signMessage(toSignatureString(form, claim));
  return { data: { form, claim }, signature: 'personal_sign_' + sig };
}

const PORT = Number(process.env.PORT || 3001);
const server = app.listen(PORT, () => console.log('demo listening on ' + PORT + ' — open http://localhost:' + PORT));
module.exports = { app, server, signedSubmission };

/**
 * Demo harness: runs the REAL Eligibility + signature/verification code paths
 * against a MOCK chain (dummy on-chain data, no RPC). For gauging behaviour/UI only.
 *
 *   node scripts/demo-server.js   # serves on :3001
 */
const express = require('express');
const cors = require('cors');
const { Wallet } = require('ethers');

const { Eligibility } = require('../dist/wildcat/eligibility');
const {
  getFormDataError,
  verifySignature,
  computeMarketsHash,
  toAccount,
  toSignatureString,
} = require('../dist/utils');

// ---- Dummy config + mock chain -------------------------------------------
const cfg = {
  network: 'mainnet',
  rpcUrl: 'mock',
  addresses: { archController: '0xArch', marketLens: '0xLens', hooksFactory: '0xFac', sanctionsSentinel: '' },
  minOwedWei: 0n,
  distressedCacheTtlSec: 300,
};

const MARKETS = [
  { market: '0x1111111111111111111111111111111111111111', borrower: '0xBobLabsTreasury000000000000000000000001', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, isDelinquent: true,  timeDelinquent: 5n*24n*3600n, grace: 3n*24n*3600n, owed: 250000n*10n**6n },
  { market: '0x2222222222222222222222222222222222222222', borrower: '0xAcmeCapitalDAO00000000000000000000000002', asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, isDelinquent: false, timeDelinquent: 9n*24n*3600n, grace: 7n*24n*3600n, owed: 40n*10n**18n },
  { market: '0x3333333333333333333333333333333333333333', borrower: '0xHealthyBorrowerInc0000000000000000000003', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, isDelinquent: false, timeDelinquent: 0n, grace: 3n*24n*3600n, owed: 100000n*10n**6n },
];

const mockChain = {
  async getAllMarkets() { return MARKETS.map((m) => m.market); },
  async readMarketSnapshot(addr) {
    const m = MARKETS.find((x) => x.market === addr);
    return {
      market: m.market, borrower: m.borrower, asset: m.asset, isClosed: false,
      isDelinquent: m.isDelinquent, timeDelinquent: m.timeDelinquent,
      delinquencyGracePeriod: m.grace, penaltyActive: m.timeDelinquent > m.grace,
      reserveRatioBips: 2000n, annualInterestBips: 1200n, delinquencyFeeBips: 1000n,
    };
  },
  async readLenderOwed(addr) { return (MARKETS.find((x) => x.market === addr) || {}).owed || 0n; },
  async readUnderlyingMeta(asset) {
    const m = MARKETS.find((x) => x.asset === asset);
    return { symbol: m ? m.symbol : 'TOK', decimals: m ? m.decimals : 18 };
  },
  async resolveBlockNumber() { return 20_500_000; },
};

const eligibility = new Eligibility(mockChain, cfg);

// ---- Server (mirrors src/index.ts endpoints) -----------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, network: cfg.network }));

app.post('/eligibility', async (req, res) => {
  const { account } = req.body || {};
  if (typeof account !== 'string') return res.status(400).send('Missing account');
  res.json(await eligibility.eligibleClaims(account));
});

app.post('/submit', async (req, res) => {
  const { data, signature } = req.body || {};
  if (!data?.form || !data?.claim || typeof signature !== 'string') return res.status(400).send('Malformed submission');
  const formError = getFormDataError(data.form);
  if (formError) return res.status(400).send(formError);
  let address;
  try { address = verifySignature(data.form, data.claim, signature); } catch { return res.status(400).send('Invalid signature'); }
  const result = await eligibility.eligibleClaims(address);
  if (!result.claims.length) return res.status(400).send('No eligible claims for this address');
  const serverHash = computeMarketsHash(result.claims.map((c) => c.market));
  if (serverHash.toLowerCase() !== data.claim.marketsHash.toLowerCase()) return res.status(409).send('Eligibility changed since signing');
  const account = toAccount(address, data.form, data.claim, signature, result.claims, result.totalOwedWei);
  res.json({ ok: true, markets: result.claims.length, totalOwedWei: result.totalOwedWei, storedFor: account.address });
});

// Helper to produce a valid signed submission for the happy-path demo.
async function signedSubmission() {
  const wallet = Wallet.createRandom();
  const result = await eligibility.eligibleClaims(wallet.address);
  const { City } = require('country-state-city');
  const city = City.getCitiesOfState('US', 'NY')[0].name; // a guaranteed-valid city
  const form = { name: 'Jane Lender', email: 'jane@example.com', other: '', country: 'US', state: 'NY', city, acceptTerms: true, willingToSpeakToLEO: false, willingToLitigate: true };
  const claim = { network: 'mainnet', snapshotBlock: result.blockNumber, marketsHash: computeMarketsHash(result.claims.map((c) => c.market)) };
  const sig = await wallet.signMessage(toSignatureString(form, claim));
  return { data: { form, claim }, signature: 'personal_sign_' + sig };
}

const PORT = Number(process.env.PORT || 3001);
const server = app.listen(PORT, () => console.log('demo listening on ' + PORT));
module.exports = { app, signedSubmission };

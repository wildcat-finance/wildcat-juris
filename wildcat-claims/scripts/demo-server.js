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
  recoverTypedSigner,
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
  debugMode: false, // production-honest; the mock defaulted market is eligible without debug
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
  async readBorrowers(markets) { return markets.map(() => DEMO_BORROWER); }, // every demo market belongs to DEMO_BORROWER
  async readMarketsInfoAndState(markets) {
    return Promise.all(markets.map(async (m) => ({ info: await this.getMarketInfo(m), state: await this.getMarketState(m) })));
  },
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
  res.json({
    ...result,
    claim: {
      network: cfg.network,
      market,
      penalizedDays: result.penalizedDays,
      amountOwedWei: result.amountOwedWei,
      asOfBlock: result.asOfBlock,
    },
  });
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
  res.json({
    ok: true, market, lender: address,
    amountOwedWei: data.claim.amountOwedWei, penalizedDays: data.claim.penalizedDays,
    asOfBlock: data.claim.asOfBlock, submittedAt: new Date().toISOString(), debug: cfg.debugMode,
  });
});

// Verify a produced proof (mirrors src/app.ts /verify against the mock chain).
app.post('/verify', async (req, res) => {
  const { signed, proof } = req.body || {};
  const domain = signed?.domain, types = signed?.types, message = signed?.message;
  const signature = proof?.signature ?? signed?.signature;
  if (!domain || !types || !message || typeof signature !== 'string') {
    return res.status(400).send('Provide a signed message (domain, types, message) and a signature.');
  }
  let recovered;
  try {
    recovered = getAddress(recoverTypedSigner(domain, types, message, signature));
  } catch (err) {
    return res.json({ signature: { valid: false, error: 'Signature does not recover a signer: ' + err.message }, overall: 'invalid', verifiedAt: new Date().toISOString() });
  }
  const claimedSigner = asAddress(proof?.signer);
  const signerMatches = claimedSigner ? claimedSigner === recovered : null;
  const claim = message.claim || {};
  const network = typeof claim.network === 'string' ? claim.network : cfg.network;
  const expectedDomain = domainFor(network);
  const domainMatches = domain.name === expectedDomain.name && String(domain.version) === String(expectedDomain.version) && Number(domain.chainId) === Number(expectedDomain.chainId);
  const networkMatches = network === cfg.network;

  const market = asAddress(claim.market);
  const asOfBlock = Number(claim.asOfBlock);
  let onChain = { checked: false };
  if (!networkMatches) {
    onChain = { checked: false, error: `Proof is for network "${network}"; this verifier serves "${cfg.network}".` };
  } else if (market && Number.isInteger(asOfBlock) && asOfBlock > 0) {
    try {
      const live = await eligibility.verifyClaimAtBlock(recovered, market, asOfBlock);
      onChain = {
        checked: true, asOfBlock, market, marketName: live.name, assetSymbol: live.assetSymbol, assetDecimals: live.assetDecimals,
        inDefault: live.inDefault, penalizedDays: live.penalizedDays, amountOwedWei: live.amountOwedWei,
        daysMatch: Number(live.penalizedDays) === Number(claim.penalizedDays), amountMatches: live.amountOwedWei === String(claim.amountOwedWei),
        signerHeldPosition: BigInt(live.amountOwedWei) > 0n, withdrawalsError: live.withdrawalsError,
      };
    } catch (err) { onChain = { checked: false, error: 'On-chain replay failed: ' + err.message }; }
  } else {
    onChain = { checked: false, error: 'Signed message has no market/asOfBlock to replay.' };
  }

  const sigOk = domainMatches && signerMatches !== false;
  const chainOk = onChain.checked ? Boolean(onChain.inDefault) && Boolean(onChain.amountMatches) && Boolean(onChain.daysMatch) : null;
  let overall;
  if (!sigOk) overall = 'invalid';
  else if (chainOk === false) overall = 'mismatch';
  else if (chainOk === true) overall = 'valid';
  else overall = 'signature-valid';

  res.json({
    signature: { valid: true, recovered, claimedSigner, signerMatches },
    domain: { matches: domainMatches, networkMatches, expected: expectedDomain, provided: domain },
    claim: { network, market, penalizedDays: Number(claim.penalizedDays), amountOwedWei: String(claim.amountOwedWei), asOfBlock },
    onChain, overall, verifiedAt: new Date().toISOString(),
  });
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
  const form = { name: 'Jane Lender', email: 'jane@example.com', other: '', country: 'US', acceptTerms: true, willingToLitigate: true };
  const claim = {
    network: 'mainnet', market: getAddress(market),
    penalizedDays: result.penalizedDays, amountOwedWei: result.amountOwedWei, asOfBlock: result.asOfBlock,
  };
  const sig = await wallet.signMessage(toSignatureString(form, claim));
  return { data: { form, claim }, signature: 'personal_sign_' + sig };
}

const PORT = Number(process.env.PORT || 3001);
const server = app.listen(PORT, () => console.log('demo listening on ' + PORT + ' — open http://localhost:' + PORT));
module.exports = { app, server, signedSubmission };

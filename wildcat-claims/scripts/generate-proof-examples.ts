/**
 * Regenerate the JSON signature-proof examples under `examples/`.
 *
 * These examples show exactly what a lender's copyable proof looks like — the same shapes the
 * frontend renders into the "Signed payload" and "Signature & verification proof" boxes, and the
 * same object `/submit` returns. They are produced with the real signing/verification code in
 * `src/utils.ts`, so they stay faithful to production and every signature genuinely verifies.
 *
 * The signer is a well-known, publicly-published test key (Hardhat/Anvil account #0). It is used
 * here ONLY so the output is deterministic and unmistakably synthetic — never a real lender key.
 * All other values (market, borrower, amount, block) are illustrative.
 *
 * Run:  npm run examples      (writes/overwrites files in examples/)
 */
import fs from 'fs';
import path from 'path';
import { Wallet, getAddress, verifyTypedData, TypedDataEncoder, hashMessage } from 'ethers';
import {
  domainFor,
  EIP712_TYPES,
  toSignatureString,
  verifySignature,
  type FormData,
  type SignedClaimContext,
} from '../src/utils';

// Publicly-published test key (Hardhat/Anvil account #0). NOT a real key — do not fund it.
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Illustrative claim data (mainnet). The market/borrower are example addresses.
const MARKET = getAddress('0x00000000000000000000000000000000000000a1');

const form: FormData = {
  name: 'Ada Lovelace',
  email: 'ada@example.io',
  other: '',
  country: 'GB',
  acceptTerms: true,
};

const claim: SignedClaimContext = {
  network: 'mainnet',
  market: MARKET,
  penalizedDays: 118,
  amountOwedWei: '250000000000', // 250,000 of a 6-decimal asset (e.g. USDC)
  asOfBlock: 20_812_345,
};

// Fixed receipt timestamp so regenerating the examples produces a stable diff.
const SUBMITTED_AT = '2026-07-03T12:00:00.000Z';

// Mirrors the typed-data `message` the frontend signs (see app-build/index.html).
const typedMessage = (f: FormData, c: SignedClaimContext) => ({
  contactInfo: { name: f.name, email: f.email || '', other: f.other || '' },
  location: { country: f.country },
  options: { acceptTerms: f.acceptTerms },
  claim: {
    network: c.network,
    market: getAddress(c.market),
    penalizedDays: c.penalizedDays,
    amountOwedWei: c.amountOwedWei,
    asOfBlock: c.asOfBlock,
  },
});

/** The object `/submit` returns on success (src/app.ts). */
const serverResponse = (lender: string) => ({
  ok: true,
  market: MARKET,
  lender,
  amountOwedWei: claim.amountOwedWei,
  penalizedDays: claim.penalizedDays,
  asOfBlock: claim.asOfBlock,
  submittedAt: SUBMITTED_AT,
  debug: false,
});

const OUT_DIR = path.join(__dirname, '..', 'examples');

function write(name: string, value: unknown): void {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  console.log('wrote', path.relative(path.join(__dirname, '..'), file));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  const signer = getAddress(wallet.address);
  const domain = domainFor(claim.network);
  const message = typedMessage(form, claim);

  // ---- EIP-712 (typed data) — the default path an EOA / injected wallet uses ---------------
  const eip712Sig = await wallet.signTypedData(domain, EIP712_TYPES, message);
  const eip712Recovered = getAddress(verifyTypedData(domain, EIP712_TYPES, message, eip712Sig));

  // Signed payload: exactly what the wallet is asked to sign (frontend "signedPre").
  write('eip712-signed-payload.json', {
    domain,
    primaryType: 'Data',
    types: EIP712_TYPES,
    message,
  });

  // Verification proof: what the frontend renders + the server's /submit response (frontend "proofPre").
  write('eip712-proof.json', {
    signatureType: 'eip712',
    signer,
    recoveredFromSignature: eip712Recovered,
    signatureValid: eip712Recovered.toLowerCase() === signer.toLowerCase(),
    typedDataHash: TypedDataEncoder.hash(domain, EIP712_TYPES, message),
    signature: eip712Sig,
    serverResponse: serverResponse(signer),
  });

  // ---- personal_sign — the fallback path (wallets that can't do signTypedData) --------------
  // The server accepts these when the signature is prefixed with "personal_sign_" (src/utils.ts).
  const messageString = toSignatureString(form, claim);
  const rawPersonalSig = await wallet.signMessage(messageString);
  const personalSig = 'personal_sign_' + rawPersonalSig;
  const personalRecovered = getAddress(verifySignature(form, claim, personalSig));

  write('personal-sign-signed-payload.json', {
    scheme: 'EIP-191 personal_sign',
    // The exact UTF-8 string the wallet signs; also shown as an escaped one-liner for copy/paste.
    messageLines: messageString.split('\n'),
    message: messageString,
  });

  write('personal-sign-proof.json', {
    signatureType: 'personal_sign',
    signer,
    recoveredFromSignature: personalRecovered,
    signatureValid: personalRecovered.toLowerCase() === signer.toLowerCase(),
    messageHash: hashMessage(messageString),
    // What the client sends to /submit in the `signature` field (note the prefix).
    signature: personalSig,
    serverResponse: serverResponse(signer),
  });

  // ---- Sanity: fail loudly if anything we just wrote does not actually verify ----------------
  if (eip712Recovered.toLowerCase() !== signer.toLowerCase()) throw new Error('EIP-712 example does not verify');
  if (personalRecovered.toLowerCase() !== signer.toLowerCase()) throw new Error('personal_sign example does not verify');
  console.log('\nAll generated proofs verify back to', signer);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

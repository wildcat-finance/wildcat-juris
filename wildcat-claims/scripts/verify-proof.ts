/**
 * Verify a lender's claim proof from the command line — the flow the Wildcat Foundation runs on a
 * proof it receives. Thin CLI over src/verify.ts (the same code the POST /verify endpoint uses).
 *
 * Usage:
 *   RPC_URL=<archive-node> npm run verify -- <bundle.json>
 *   RPC_URL=<archive-node> npm run verify -- <signed-payload.json> <proof.json>
 *
 * - RPC_URL defaults to the Wildcat/Juris archive node baked into config.ts, so for mainnet you can
 *   usually omit it. For a sepolia claim also set WILDCAT_NETWORK=sepolia.
 * - Pass one combined bundle ({ payload, proof }) or the two boxes as separate files.
 */
import fs from 'fs';
import { loadConfig } from '../src/wildcat/config';
import { verifyProof, NetworkMismatchError, type ProofBundle } from '../src/verify';

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const ok = (b: boolean) => (b ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m');

function loadBundle(args: string[]): ProofBundle {
  if (args.length === 1) {
    const b = readJson(args[0]);
    if (b.payload && b.proof) return b as ProofBundle;
    throw new Error('single-file input must be a bundle: { payload, proof }');
  }
  if (args.length === 2) return { payload: readJson(args[0]), proof: readJson(args[1]) };
  throw new Error('usage: npm run verify -- <bundle.json> | <signed-payload.json> <proof.json>');
}

async function main(): Promise<void> {
  let bundle: ProofBundle;
  try {
    bundle = loadBundle(process.argv.slice(2));
  } catch (err: any) {
    console.error(err.message);
    process.exit(2);
  }

  let report;
  try {
    report = await verifyProof(bundle, loadConfig());
  } catch (err: any) {
    console.error(err instanceof NetworkMismatchError ? `network mismatch: ${err.message}` : err);
    process.exit(2);
  }

  const { claim, claimed } = report;
  console.log(`\nClaim: ${claimed} owes ${claim.amountOwedWei} wei in ${claim.market}`);
  console.log(`       penalized ${claim.penalizedDays}d, as of block ${claim.asOfBlock} on ${claim.network}\n`);
  if (report.debug) {
    console.log('\x1b[33m⚠  this proof was produced in DEBUG mode — its figures were assumed, not ' +
      'real, so the on-chain check will not reconcile. Real claims come from a debug-off deployment.\x1b[0m\n');
  }

  const s = report.signature;
  console.log(`1. Signature authenticity (${s.method}): ${ok(s.valid)}${s.error ? ` (${s.error})` : ''}`);

  const o = report.onchain;
  if (o.read) {
    console.log(`2. On-chain figures @ block ${claim.asOfBlock}: ${ok(o.ok)}`);
    console.log(`     amountOwedWei  claim=${o.amountOwedWei.claim}  chain=${o.amountOwedWei.chain}  ${ok(o.amountOwedWei.match)}`);
    console.log(`     penalizedDays  claim=${o.penalizedDays.claim}  chain=${o.penalizedDays.chain}  ${ok(o.penalizedDays.match)}`);
  } else {
    console.log(`2. On-chain figures @ block ${claim.asOfBlock}: ${ok(false)} (read failed: ${o.error})`);
  }

  console.log(`\nRESULT: ${report.verified ? '\x1b[32mVERIFIED\x1b[0m' : '\x1b[31mNOT VERIFIED\x1b[0m'} — ` +
    `${claimed} ${report.verified ? 'is a proven impacted lender in this market.' : 'could not be fully verified (see above).'}\n`);
  process.exit(report.verified ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

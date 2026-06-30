/**
 * Proof: the claim flow works with a Safe multisig (EIP-1271).
 *
 * A Safe has no private key — it "signs" by having its owner threshold authorize a hash, which
 * any verifier checks via EIP-1271 `isValidSignature(hash, signatures) -> 0x1626ba7e`. This
 * script spins up a local chain, deploys a faithful mock Safe (2-of-3, same EIP-1271 interface
 * + ascending-owner threshold check as a real Safe), produces an owner-threshold signature over
 * the real claim digest, and shows the tool's actual verification (chain.isValidErc1271 — the
 * code path /submit uses) accepting it. Eligibility (market.balanceOf(safe)) is address-agnostic,
 * so this covers the only Safe-specific concern: signature validation.
 *
 * Run:  npm i -D ganache solc && npm run build && node scripts/prove-safe-eip1271.js
 */
const ganache = require('ganache');
const solc = require('solc');
const { JsonRpcProvider, Network, ContractFactory, Contract, SigningKey, Wallet, getAddress } = require('ethers');
const { claimDigest } = require('../dist/utils');
const { Chain } = require('../dist/wildcat/chain');

const MOCK_SAFE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
/// Minimal Safe-like wallet: EIP-1271 with an ascending-owner threshold check (as Safe does).
contract MockSafe {
  mapping(address => bool) public isOwner;
  uint256 public threshold;
  constructor(address[] memory owners, uint256 _threshold) {
    for (uint256 i = 0; i < owners.length; i++) isOwner[owners[i]] = true;
    threshold = _threshold;
  }
  function isValidSignature(bytes32 hash, bytes memory signatures) public view returns (bytes4) {
    require(signatures.length >= threshold * 65, "not enough signatures");
    address last = address(0);
    uint256 valid = 0;
    for (uint256 i = 0; i < threshold; i++) {
      bytes32 r; bytes32 s; uint8 v;
      assembly {
        let p := add(add(signatures, 0x20), mul(i, 65))
        r := mload(p)
        s := mload(add(p, 0x20))
        v := byte(0, mload(add(p, 0x40)))
      }
      address signer = ecrecover(hash, v, r, s);
      require(signer > last, "owners must be ascending and unique");
      last = signer;
      if (isOwner[signer]) valid++;
    }
    return valid >= threshold ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
  }
}`;

function compile() {
  const input = {
    language: 'Solidity',
    sources: { 'MockSafe.sol': { content: MOCK_SAFE } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['MockSafe.sol']['MockSafe'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// Build an owner-threshold signature: each owner ECDSA-signs the digest; concat in ascending
// owner-address order (exactly what Safe.checkSignatures expects).
function packSignatures(signers, digest) {
  return (
    '0x' +
    signers
      .slice()
      .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))
      .map((w) => new SigningKey(w.privateKey).sign(digest).serialized.slice(2))
      .join('')
  );
}

(async () => {
  const PORT = 8899;
  const server = ganache.server({ chain: { chainId: 1 }, logging: { quiet: true } });
  await server.listen(PORT);
  const rpc = `http://127.0.0.1:${PORT}`;
  const provider = new JsonRpcProvider(rpc, Network.from(1), { staticNetwork: Network.from(1) });
  const deployer = await provider.getSigner(0);

  // A 2-of-3 Safe.
  const owners = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
  const { abi, bytecode } = compile();
  const safe = await new ContractFactory(abi, bytecode, deployer).deploy(
    owners.map((o) => o.address),
    2
  );
  await safe.waitForDeployment();
  const safeAddr = await safe.getAddress();

  // The exact claim a lender signs (same shape the frontend builds / the server verifies).
  const form = { name: 'Acme Capital DAO', email: 'ops@acme.fund', other: '', country: 'US', acceptTerms: true };
  const claim = {
    network: 'mainnet',
    market: getAddress('0x1111111111111111111111111111111111111111'),
    penalizedDays: 90,
    amountOwedWei: '250000000000',
    asOfBlock: 20500000,
  };
  const digest = claimDigest(form, claim, '0x'); // EIP-712 path (the digest a Safe validates)

  // Two of the three owners authorize it.
  const sigOk = packSignatures([owners[0], owners[1]], digest);
  // Negative control: one owner (below the 2-of-3 threshold).
  const sigShort = packSignatures([owners[0]], digest);

  const chain = new Chain({
    network: 'mainnet',
    chainId: 1,
    rpcUrl: rpc,
    addresses: {
      archController: '0x0000000000000000000000000000000000000001',
      marketLens: '0x0000000000000000000000000000000000000002',
      hooksFactory: '0x0000000000000000000000000000000000000003',
      sanctionsSentinel: '',
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
    defaultBufferSec: 90 * 86400,
    includeWithdrawals: true,
    minOwedWei: 0n,
    lensMode: 'lens',
    debugMode: false,
  });

  const safeRead = new Contract(safeAddr, ['function isValidSignature(bytes32,bytes) view returns (bytes4)'], provider);

  console.log('Mock Safe (2-of-3) deployed at', safeAddr);
  console.log('Owners                        ', owners.map((o) => o.address));
  console.log('Claim digest (EIP-712)        ', digest);
  console.log('');
  console.log('— Raw EIP-1271 (what any verifier sees) —');
  console.log('  isValidSignature(digest, 2 owner sigs) =', await safeRead.isValidSignature(digest, sigOk), '(0x1626ba7e = valid)');
  const shortResult = await safeRead.isValidSignature(digest, sigShort).catch((e) => `reverted: ${e.reason}`);
  console.log('  isValidSignature(digest, 1 owner sig)  =', shortResult, '(below threshold → rejected)');
  console.log('');
  console.log('— Through the tool’s actual verification code —');
  console.log('  chain.isContract(safe)                 =', await chain.isContract(safeAddr));
  console.log('  chain.isValidErc1271(safe, 2 sigs)     =', await chain.isValidErc1271(safeAddr, digest, sigOk), '  ← /submit accepts the Safe');
  console.log('  chain.isValidErc1271(safe, 1 sig)      =', await chain.isValidErc1271(safeAddr, digest, sigShort), '  ← rejected (threshold not met)');
  console.log('  chain.isValidErc1271(safe, garbage)    =', await chain.isValidErc1271(safeAddr, digest, '0x' + '00'.repeat(65)));

  await server.close();
  process.exit(0);
})().catch((e) => {
  console.error('PROOF FAILED:', e);
  process.exit(1);
});

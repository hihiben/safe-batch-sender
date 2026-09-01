#!/usr/bin/env node
// Builds a batch link, for testing this app without going through the Slack command.
//
// The production link is built by gas-refill-util's Apps Script. This script exists so the app can
// be exercised end to end — including the design's "first run with real funds must be a small
// amount" step — without deploying anything there.
//
// Usage:
//   node tools/make-link.js --chain 4663 --safe 0xEeFa... --label "test" \
//        --app https://hihiben.github.io/safe-batch-sender/ \
//        0xRecipientA=0.0005 0xRecipientB=0.0005
//
// Amounts are in the chain's native unit and are converted the way gas-refill-util's ethToWei()
// does it: through the decimal string at 10 places, never `amount * 1e18`. Pass `--wei` to give
// integer wei directly instead.

import { CHAINS } from '../payload.js';

// Mirrors gas-refill-util/GenerateGas.js: TOP_UP_DECIMALS = 10, because (0.1).toFixed(18) is
// "0.100000000000000006" and that error lands in the wei digits.
const TOP_UP_DECIMALS = 10;
const ethToWei = (amountEth) => {
  const [whole, frac] = Number(amountEth).toFixed(TOP_UP_DECIMALS).split('.');
  const wei = (whole + frac + '0'.repeat(18 - TOP_UP_DECIMALS)).replace(/^0+/, '');
  return wei === '' ? '0' : wei;
};

const argv = process.argv.slice(2);

// Track which positions a flag has consumed, so a value containing '=' — a label almost always
// does once you start testing awkward input — is not mistaken for a recipient pair.
const consumed = new Set();
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  consumed.add(i).add(i + 1);
  return argv[i + 1];
};
const has = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return false;
  consumed.add(i);
  return true;
};

const chainId = flag('chain');
const safe = flag('safe');
const label = flag('label', '');
const appUrl = flag('app', 'http://localhost:8000/');
const wei = has('wei');
const pairs = argv.filter((a, i) => !consumed.has(i) && !a.startsWith('--') && a.includes('='));

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

if (!chainId || !CHAINS[chainId]) die(`--chain must be one of ${Object.keys(CHAINS).join(', ')}`);
if (!/^0x[0-9a-fA-F]{40}$/.test(safe ?? '')) die('--safe must be a 20-byte hex address');
if (pairs.length === 0) die('give at least one recipient as 0xAddress=amount');

const txs = pairs.map((pair) => {
  const [to, amount] = pair.split('=');
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) die(`not an address: ${to}`);
  const value = wei ? amount : ethToWei(amount);
  if (!/^[1-9][0-9]*$/.test(value)) die(`amount does not convert to positive integer wei: ${pair}`);
  return [to, value];
});

const payload = { v: 1, chainId, safe, label, txs };
const fragment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const total = txs.reduce((acc, [, v]) => acc + BigInt(v), 0n);

const chain = CHAINS[chainId];
const appLink = `${appUrl.replace(/\/$/, '')}/#${fragment}`;
const safeLink =
  `https://app.safe.global/apps/open?safe=${chain.prefix}:${safe}` +
  `&appUrl=${encodeURIComponent(appLink)}`;

console.log(`chain      ${chain.name} (${chainId})`);
console.log(`recipients ${txs.length}`);
console.log(`total      ${total} wei`);
console.log(`fragment   ${fragment.length} chars`);
console.log('');
console.log('app only (read-only outside Safe):');
console.log(appLink);
console.log('');
console.log('open in Safe:');
console.log(safeLink);

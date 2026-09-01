// Run with: node --test test/
//
// Covers the refusal rules from the design's §6 that live in pure code: rule 2 (decode + schema),
// rule 3 (chain), rule 4 (Safe address), rule 6 (wei format). Rule 1 (are we inside a Safe iframe)
// is a property of the messaging client and is covered in safe-client.test.js.
//
// Rule 5 is deliberately absent. The recipient allowlist was removed from the design; see the
// "What this app does not check" section of README.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAINS,
  PayloadError,
  checkChain,
  checkSafe,
  decodeFragment,
  formatUnits,
  parseLink,
  sumWei,
  validatePayload,
} from '../payload.js';

const SAFE = '0xEeFa622109b5E97B98220729Fa35fC037B7B3212';
const TANK_A = '0x5F8D0e1b0e1b0e1b0e1b0e1b0e1b0e1b0e1b0e1b';
const TANK_B = '0x5083D0e1b0e1b0e1b0e1b0e1b0e1b0e1b0e1b0e1';

const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

const good = (over = {}) => ({
  v: 1,
  chainId: '4663',
  safe: SAFE,
  label: 'uniswapx gas top-up on robinhood',
  txs: [[TANK_A, '10000000000000000'], [TANK_B, '10000000000000000']],
  ...over,
});

const refuses = (fn, match) => assert.throws(fn, (e) => e instanceof PayloadError && match.test(e.message), String(match));

// ── happy path ────────────────────────────────────────────────────────────────────────────────

test('a well-formed link parses, and txs become {to, value} objects', () => {
  const p = parseLink('#' + encode(good()));
  assert.equal(p.v, 1);
  assert.equal(p.chainId, '4663');
  assert.equal(p.safe, SAFE);
  assert.equal(p.label, 'uniswapx gas top-up on robinhood');
  assert.deepEqual(p.txs, [
    { to: TANK_A, value: '10000000000000000' },
    { to: TANK_B, value: '10000000000000000' },
  ]);
});

test('a fragment without the leading # parses the same way', () => {
  assert.deepEqual(parseLink(encode(good())), parseLink('#' + encode(good())));
});

test('a multi-byte label survives the round trip', () => {
  const label = 'robinhood 加油 — 30 筆';
  assert.equal(parseLink('#' + encode(good({ label }))).label, label);
});

test('label is optional and defaults to empty', () => {
  const { label, ...noLabel } = good();
  assert.equal(parseLink('#' + encode(noLabel)).label, '');
});

test('every chain in the payload format is a known chain', () => {
  for (const chainId of ['1', '56', '100', '4663', '8453', '42161']) {
    assert.ok(CHAINS[chainId], `chain ${chainId} missing`);
    assert.equal(parseLink('#' + encode(good({ chainId }))).chainId, chainId);
  }
});

// ── rule 2: decode ────────────────────────────────────────────────────────────────────────────

test('rule 2: an empty fragment is refused', () => {
  refuses(() => parseLink(''), /carries no batch/);
  refuses(() => parseLink('#'), /carries no batch/);
  refuses(() => parseLink(undefined), /carries no batch/);
});

test('rule 2: characters outside the base64url alphabet are refused', () => {
  refuses(() => parseLink('#eyJ2Ijox!!'), /not valid base64url/);
  refuses(() => parseLink('#eyJ2Ijox=='), /not valid base64url/); // padding is stripped by the sender
});

test('rule 2: a truncated payload is refused', () => {
  refuses(() => parseLink('#A'), /not valid base64url/);
});

test('rule 2: bytes that are not valid UTF-8 are refused', () => {
  refuses(() => parseLink('#_w'), /not valid UTF-8/); // 0xFF
});

test('rule 2: valid base64url that is not JSON is refused', () => {
  refuses(() => parseLink('#' + Buffer.from('not json', 'utf8').toString('base64url')), /not valid JSON/);
});

test('rule 2: JSON that is not an object is refused', () => {
  for (const notObject of ['[1,2]', '"a string"', '42', 'null']) {
    refuses(() => validatePayload(decodeFragment('#' + Buffer.from(notObject, 'utf8').toString('base64url'))),
      /not a JSON object/);
  }
});

// ── rule 2: schema ────────────────────────────────────────────────────────────────────────────

test('rule 2: an unrecognised field is refused rather than ignored', () => {
  refuses(() => parseLink('#' + encode({ ...good(), operation: 1 })), /unrecognised field\(s\): operation/);
});

test('rule 2: a version other than 1 is refused', () => {
  for (const v of [2, '1', 0, undefined, null]) {
    refuses(() => parseLink('#' + encode({ ...good(), v })), /Unsupported payload version/);
  }
});

test('rule 2: an unknown or non-string chain ID is refused', () => {
  for (const chainId of ['137', '', 4663, null]) {
    refuses(() => parseLink('#' + encode(good({ chainId }))), /Unknown chain ID/);
  }
});

test('rule 2: a malformed Safe address is refused', () => {
  for (const safe of [SAFE.slice(0, -1), SAFE + '00', SAFE.replace('0x', ''), 'not an address', 42, null]) {
    refuses(() => parseLink('#' + encode(good({ safe }))), /not a 20-byte hex address/);
  }
});

test('rule 2: a non-string label is refused', () => {
  refuses(() => parseLink('#' + encode(good({ label: { toString: 1 } }))), /label is not a string/);
});

test('rule 2: an empty or non-array txs is refused', () => {
  for (const txs of [[], {}, 'x', null, undefined]) {
    refuses(() => parseLink('#' + encode(good({ txs }))), /carries no transactions/);
  }
});

test('rule 2: a tx that is not a [to, wei] pair is refused', () => {
  for (const entry of [[TANK_A], [TANK_A, '1', '0x'], { to: TANK_A, value: '1' }, 'x']) {
    refuses(() => parseLink('#' + encode(good({ txs: [entry] }))), /is not a \[to, wei\] pair/);
  }
});

test('rule 2: a malformed recipient is refused, and the message says which transaction', () => {
  refuses(
    () => parseLink('#' + encode(good({ txs: [[TANK_A, '1'], ['0xdeadbeef', '1']] }))),
    /Transaction 2 has a recipient that is not a 20-byte hex address/,
  );
});

// ── rule 6: wei format ────────────────────────────────────────────────────────────────────────

test('rule 6: anything but a positive integer wei string is refused', () => {
  // No BigInt here: JSON.stringify refuses to serialize one, so it can never reach a payload.
  const bad = ['0', '-1', '+1', '1.5', '01', '1e18', '0x10', ' 1', '1 ', '', '一', 1, null, undefined];
  for (const value of bad) {
    refuses(
      () => parseLink('#' + encode(good({ txs: [[TANK_A, value]] }))),
      /is not a positive integer wei string/,
    );
  }
});

test('rule 6: a large amount is accepted as a string', () => {
  const value = '123456789012345678901234567890';
  assert.equal(parseLink('#' + encode(good({ txs: [[TANK_A, value]] }))).txs[0].value, value);
});

// ── rule 3: chain ─────────────────────────────────────────────────────────────────────────────

test('rule 3: a chain ID matching the connected Safe passes', () => {
  checkChain(good(), { chainId: 4663, safeAddress: SAFE });
  checkChain(good(), { chainId: '4663', safeAddress: SAFE });
});

test('rule 3: a chain mismatch is refused, naming both chains', () => {
  refuses(
    () => checkChain(parseLink('#' + encode(good({ chainId: '8453' }))), { chainId: 4663, safeAddress: SAFE }),
    /link is for chain 8453 \(Base\).*connected Safe is on chain 4663 \(Robinhood Chain\)/,
  );
});

// ── rule 4: Safe address ──────────────────────────────────────────────────────────────────────

test('rule 4: the Safe address compares case-insensitively', () => {
  checkSafe(good(), { chainId: 4663, safeAddress: SAFE.toLowerCase() });
  checkSafe(good(), { chainId: 4663, safeAddress: SAFE.toUpperCase().replace('0X', '0x') });
});

test('rule 4: a different Safe is refused, naming both addresses', () => {
  const other = '0x' + '1'.repeat(40);
  refuses(() => checkSafe(good(), { chainId: 4663, safeAddress: other }), /link is for Safe 0xEeFa.*connected Safe is 0x1111/);
});

test('rule 4: a missing Safe address is refused rather than treated as a match', () => {
  refuses(() => checkSafe(good(), { chainId: 4663 }), /connected Safe is \(unknown\)/);
});

// ── wei formatting ────────────────────────────────────────────────────────────────────────────

test('formatUnits pads and trims by string, never by float', () => {
  const cases = [
    ['1000000000000000000', '1'],
    ['10000000000000000', '0.01'],
    ['100000000000000000', '0.1'],
    ['1', '0.000000000000000001'],
    ['123456789012345678', '0.123456789012345678'],
    ['1000000000000000001', '1.000000000000000001'],
    ['21000000000000000000000000', '21000000'],
  ];
  for (const [wei, expected] of cases) assert.equal(formatUnits(wei), expected, wei);
});

test('formatUnits is the inverse of gas-refill-util ethToWei for the value that broke toFixed(18)', () => {
  // ethToWei(0.1) goes through toFixed(10) precisely to avoid "0.100000000000000006".
  assert.equal(formatUnits('100000000000000000'), '0.1');
});

test('formatUnits refuses a non-integer input rather than rendering garbage', () => {
  for (const wei of ['0.1', '-1', '1e18', 'x', '']) {
    assert.throws(() => formatUnits(wei), PayloadError, wei);
  }
});

test('sumWei adds without precision loss past 2^53', () => {
  assert.equal(sumWei(['10000000000000000', '10000000000000000']), '20000000000000000');
  assert.equal(sumWei(Array(30).fill('123456789012345678')), '3703703670370370340');
  assert.equal(sumWei(['1']), '1');
});

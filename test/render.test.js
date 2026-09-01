// Run with: node --test test/
//
// Drives app.js end to end against the DOM stub and a fake Safe interface. These tests answer the
// question the unit tests cannot: does the page actually build, and does the send button appear
// exactly when every verification rule has passed?
//
// app.js runs its work on import, so each case imports it under a unique specifier to defeat the
// ES module cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-stub.js';
import { SDK_VERSION } from '../vendor/safe-client.js';

const SAFE = '0xEeFa622109b5E97B98220729Fa35fC037B7B3212';
const TANK_A = '0x5F8D0e1b0e1b0e1b0e1b0e1b0e1b0e1b0e1b0e1b';
const TANK_B = '0x5083D0e1b0e1b0e1b0e1b0e1b0e1b0e1b0e1b0e1';

const SAFE_INFO = { safeAddress: SAFE, chainId: 4663, threshold: 1, owners: Array(6).fill(TANK_A), isReadOnly: false };

const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

const batch = (over = {}) => ({
  v: 1,
  chainId: '4663',
  safe: SAFE,
  label: 'uniswapx gas top-up on robinhood',
  txs: [[TANK_A, '500000000000000'], [TANK_B, '700000000000000']],
  ...over,
});

let caseNumber = 0;

/** Install the stub, run app.js once, and hand back the handles. */
async function load({ hash, reply }) {
  const dom = installDom({ hash, reply });
  await import(`../app.js?case=${++caseNumber}`);
  await dom.settle();
  return dom;
}

const respondWith = (data) => (msg) => ({ id: msg.id, success: true, version: SDK_VERSION, data });

/** The interface answers getSafeInfo, then answers sendTransactions with a hash. */
const fullyWorkingSafe = (safeInfo = SAFE_INFO, safeTxHash = '0xf00d') => (msg) =>
  msg.method === 'getSafeInfo'
    ? { id: msg.id, success: true, version: SDK_VERSION, data: safeInfo }
    : { id: msg.id, success: true, version: SDK_VERSION, data: { safeTxHash } };

// ── the confirm screen ────────────────────────────────────────────────────────────────────────

test('a verified batch renders the confirm screen and the send button', async () => {
  const dom = await load({ hash: '#' + encode(batch()), reply: fullyWorkingSafe() });

  assert.ok(dom.button(), 'the send button must exist once every rule has passed');
  assert.equal(dom.byId.get('refusal').hidden, true, 'nothing was refused');
  assert.equal(dom.byId.get('batch').hidden, false);
  assert.equal(dom.byId.get('checks').hidden, false);
  assert.match(dom.text('status'), /Verified\. 2 transactions ready to propose/);
});

test('every recipient appears with its amount in both native units and wei', async () => {
  const dom = await load({ hash: '#' + encode(batch()), reply: fullyWorkingSafe() });
  const shown = dom.text('batch');

  for (const address of [TANK_A, TANK_B]) assert.ok(shown.includes(address), `missing ${address}`);
  assert.ok(shown.includes('0.0005'), 'missing 0.0005 in native units');
  assert.ok(shown.includes('0.0007'), 'missing 0.0007 in native units');
  assert.ok(shown.includes('500000000000000'), 'missing wei for tank A');
  assert.ok(shown.includes('700000000000000'), 'missing wei for tank B');
});

test('the confirm screen states the chain, the Safe, the count and the total', async () => {
  const dom = await load({ hash: '#' + encode(batch()), reply: fullyWorkingSafe() });
  const shown = dom.text('batch');

  assert.ok(shown.includes('Robinhood Chain (chain ID 4663)'), shown);
  assert.ok(shown.includes(SAFE));
  assert.ok(shown.includes('2 native transfers'));
  assert.ok(shown.includes('0.0012'), 'total of 0.0005 + 0.0007');
});

test('the confirm screen says outright that recipients are not checked', async () => {
  const dom = await load({ hash: '#' + encode(batch()), reply: fullyWorkingSafe() });
  const shown = dom.text('checks');

  assert.match(shown, /not checked against any list/);
  assert.match(shown, /1 of 6 owners/, 'threshold must be visible: one signature executes this');
});

test('a label is rendered as text, never as markup', async () => {
  const label = '<img src=x onerror=alert(1)> 加油';
  const dom = await load({ hash: '#' + encode(batch({ label })), reply: fullyWorkingSafe() });

  // The stub has no HTML parser, so the assertion that matters is that the exact string survives
  // intact as text content — the CI grep is what forbids the API that would have parsed it.
  assert.ok(dom.text('batch').includes(label), 'the label must appear verbatim as text');
});

// ── proposing ─────────────────────────────────────────────────────────────────────────────────

test('the button proposes the batch as native transfers and shows the safeTxHash', async () => {
  const dom = await load({ hash: '#' + encode(batch()), reply: fullyWorkingSafe(SAFE_INFO, '0xabc123') });

  await dom.button().dispatch('click');
  await dom.settle();

  const proposal = dom.posted.find((m) => m.method === 'sendTransactions');
  assert.deepEqual(proposal.params, {
    txs: [
      { to: TANK_A, value: '500000000000000', data: '0x' },
      { to: TANK_B, value: '700000000000000', data: '0x' },
    ],
  });

  assert.equal(dom.byId.get('result').hidden, false);
  assert.ok(dom.text('result').includes('0xabc123'));
  assert.match(dom.text('status'), /Proposed/);
});

test('a rejected proposal re-enables the button and says why', async () => {
  const reply = (msg) =>
    msg.method === 'getSafeInfo'
      ? { id: msg.id, success: true, version: SDK_VERSION, data: SAFE_INFO }
      : { id: msg.id, success: false, version: SDK_VERSION, error: 'Transaction rejected' };

  const dom = await load({ hash: '#' + encode(batch()), reply });
  await dom.button().dispatch('click');
  await dom.settle();

  assert.equal(dom.button().disabled, false, 'the operator must be able to try again');
  assert.match(dom.text('status'), /Not proposed: Transaction rejected/);
  assert.equal(dom.byId.get('result').hidden, true);
});

// ── refusals: no button, ever ─────────────────────────────────────────────────────────────────

test('rule 1: when getSafeInfo fails the batch is readable but there is no button', async () => {
  // Triggered here with an error reply rather than silence, so the test does not have to sit out
  // the real 8s deadline. The silence-and-time-out path itself is covered in safe-client.test.js.
  const dom = await load({
    hash: '#' + encode(batch()),
    reply: (msg) => ({ id: msg.id, success: false, version: SDK_VERSION, error: 'Not a Safe App context' }),
  });

  assert.equal(dom.button(), null, 'no button without a reply from the interface');
  assert.equal(dom.byId.get('batch').hidden, false, 'the batch stays readable for inspection');
  assert.ok(dom.text('batch').includes(TANK_A));
  assert.match(dom.text('checks'), /not running inside Safe/);
  assert.match(dom.text('status'), /Read-only/);
});

test('rule 2: a broken fragment refuses, and does not render a batch', async () => {
  const dom = await load({ hash: '#not-base64url-@@@', reply: fullyWorkingSafe() });

  assert.equal(dom.button(), null);
  assert.equal(dom.byId.get('refusal').hidden, false);
  assert.equal(dom.byId.get('batch').hidden, true, 'nothing decoded, so there is nothing to show');
  assert.match(dom.text('refusal'), /not valid base64url/);
});

test('rule 2: an empty fragment explains where the link should come from', async () => {
  const dom = await load({ hash: '', reply: fullyWorkingSafe() });
  assert.equal(dom.button(), null);
  assert.match(dom.text('refusal'), /topup-gastank/);
});

test('rule 3: a chain mismatch refuses and names both chains', async () => {
  const dom = await load({ hash: '#' + encode(batch({ chainId: '8453' })), reply: fullyWorkingSafe() });

  assert.equal(dom.button(), null, 'wrong chain must not be proposable');
  assert.match(dom.text('refusal'), /chain 8453 \(Base\)/);
  assert.match(dom.text('refusal'), /chain 4663 \(Robinhood Chain\)/);
  assert.equal(dom.byId.get('batch').hidden, false, 'still readable, just not sendable');
});

test('rule 4: a different Safe refuses and names both addresses', async () => {
  const other = '0x' + '1'.repeat(40);
  const dom = await load({ hash: '#' + encode(batch({ safe: other })), reply: fullyWorkingSafe() });

  assert.equal(dom.button(), null);
  assert.match(dom.text('refusal'), new RegExp(other));
  assert.match(dom.text('refusal'), new RegExp(SAFE));
});

test('rule 6: a zero amount refuses before anything is rendered', async () => {
  const dom = await load({ hash: '#' + encode(batch({ txs: [[TANK_A, '0']] })), reply: fullyWorkingSafe() });

  assert.equal(dom.button(), null);
  assert.match(dom.text('refusal'), /not a positive integer wei string/);
});

test('a Safe address that matches only by case still passes rule 4', async () => {
  const dom = await load({
    hash: '#' + encode(batch({ safe: SAFE.toLowerCase() })),
    reply: fullyWorkingSafe(),
  });
  assert.ok(dom.button(), 'EIP-55 casing is not identity');
});

// ── informational, not a refusal ──────────────────────────────────────────────────────────────

test('a read-only session is warned about but still gets the button', async () => {
  const dom = await load({
    hash: '#' + encode(batch()),
    reply: fullyWorkingSafe({ ...SAFE_INFO, isReadOnly: true }),
  });

  assert.ok(dom.button(), 'isReadOnly is not one of the six rules');
  assert.match(dom.text('checks'), /Connected as a watcher/);
});

test('a malformed getSafeInfo reply does not leave the page stuck on "Checking"', async () => {
  const dom = await load({ hash: '#' + encode(batch()), reply: respondWith({ safeAddress: SAFE, chainId: 4663 }) });

  // No threshold, no owners. Rules 3 and 4 still pass, so this must render rather than throw.
  assert.ok(dom.button());
  assert.match(dom.text('checks'), /\? of 0 owners/);
  assert.doesNotMatch(dom.text('status'), /Checking/);
});

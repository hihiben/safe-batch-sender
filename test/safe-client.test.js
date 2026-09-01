// Run with: node --test test/
//
// Covers verification rule 1 — "are we really inside a Safe iframe?" — plus the message validation
// this client does. Rule 1 exists only because of the timeout added here: the real SDK's promise
// never settles when nothing answers, so it cannot express this check at all.
//
// The client takes an injectable `win` so the protocol can be exercised without a browser. The
// fake below stands in for the Safe interface on the other side of postMessage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SAFE_PARENT_ORIGIN, SDK_VERSION, SafeClientError, createSafeClient } from '../vendor/safe-client.js';

const SAFE_INFO = {
  safeAddress: '0xEeFa622109b5E97B98220729Fa35fC037B7B3212',
  chainId: 4663,
  threshold: 1,
  owners: ['0x' + '1'.repeat(40)],
  isReadOnly: false,
};

/**
 * A fake window whose parent behaves like the Safe interface.
 *
 * @param {object} [o]
 * @param {null|((req: object) => object|null)} [o.reply] - build the response envelope, or null to
 *   stay silent. Defaults to a well-formed success response.
 * @param {string} [o.origin] - the origin the response appears to come from
 * @param {boolean} [o.topLevel] - simulate a top-level (un-iframed) load
 */
function fakeWindow({ reply, origin = SAFE_PARENT_ORIGIN, topLevel = false } = {}) {
  const listeners = [];
  const posted = [];

  const win = {
    crypto: globalThis.crypto,
    addEventListener: (type, fn) => {
      if (type === 'message') listeners.push(fn);
    },
  };

  const deliver = (data, from) => {
    for (const fn of listeners) fn({ source: from, origin, data });
  };

  const parent = {
    postMessage: (msg, targetOrigin) => {
      posted.push({ msg, targetOrigin });
      const response = reply === undefined
        ? { id: msg.id, success: true, version: SDK_VERSION, data: SAFE_INFO }
        : reply?.(msg) ?? null;
      if (response) setTimeout(() => deliver(response, win.parent), 0);
    },
  };

  win.parent = topLevel ? win : parent;
  return { win, posted, deliver };
}

const rejects = (promise, match) =>
  assert.rejects(promise, (e) => e instanceof SafeClientError && match.test(e.message), String(match));

// ── the happy path and the request envelope ───────────────────────────────────────────────────

test('getSafeInfo resolves with what the interface sent', async () => {
  const { win } = fakeWindow();
  assert.deepEqual(await createSafeClient({ win }).getSafeInfo(), SAFE_INFO);
});

test('the request envelope matches the SDK: id, method, params, env.sdkVersion', async () => {
  const { win, posted } = fakeWindow();
  await createSafeClient({ win }).getSafeInfo();

  assert.equal(posted.length, 1);
  const { msg } = posted[0];
  assert.match(msg.id, /^[0-9a-f]{10}$/, 'id is 10 hex chars, as SDK generateId(10) produces');
  assert.equal(msg.method, 'getSafeInfo');
  assert.equal(msg.params, undefined);
  assert.deepEqual(msg.env, { sdkVersion: SDK_VERSION });
});

test('requests post to the pinned parent origin, not to "*"', async () => {
  const { win, posted } = fakeWindow();
  await createSafeClient({ win }).getSafeInfo();
  assert.equal(posted[0].targetOrigin, SAFE_PARENT_ORIGIN);
});

test('sendTransactions passes { txs } and resolves the safeTxHash', async () => {
  const txs = [{ to: '0x' + 'a'.repeat(40), value: '10000000000000000', data: '0x' }];
  const { win, posted } = fakeWindow({
    reply: (msg) => ({ id: msg.id, success: true, version: SDK_VERSION, data: { safeTxHash: '0xabc' } }),
  });

  const result = await createSafeClient({ win }).sendTransactions(txs);

  assert.equal(posted[0].msg.method, 'sendTransactions');
  assert.deepEqual(posted[0].msg.params, { txs });
  assert.deepEqual(result, { safeTxHash: '0xabc' });
});

test('concurrent requests are matched by id, not by arrival order', async () => {
  // Answer in reverse: the second request gets its reply first.
  const queued = [];
  const { win, deliver } = fakeWindow({
    reply: (msg) => {
      queued.push(msg.id);
      return null;
    },
  });
  const client = createSafeClient({ win, timeoutMs: 500 });

  const a = client.getSafeInfo();
  const b = client.sendTransactions([]);
  await new Promise((r) => setTimeout(r, 0));

  deliver({ id: queued[1], success: true, version: SDK_VERSION, data: { safeTxHash: '0xB' } }, win.parent);
  deliver({ id: queued[0], success: true, version: SDK_VERSION, data: SAFE_INFO }, win.parent);

  assert.deepEqual(await a, SAFE_INFO);
  assert.deepEqual(await b, { safeTxHash: '0xB' });
});

// ── rule 1: are we inside a Safe iframe? ──────────────────────────────────────────────────────

test('rule 1: a top-level load is refused immediately, not left hanging', async () => {
  const { win, posted } = fakeWindow({ topLevel: true });
  await rejects(createSafeClient({ win }).getSafeInfo(), /Not running inside an iframe/);
  assert.equal(posted.length, 0, 'nothing should be posted when there is no parent');
});

test('rule 1: silence times out', async () => {
  const { win } = fakeWindow({ reply: () => null });
  await rejects(createSafeClient({ win, timeoutMs: 20 }).getSafeInfo(), /No response from the Safe interface within 20ms/);
});

// ── message validation ────────────────────────────────────────────────────────────────────────

test('a reply from the wrong origin is ignored, so the request still times out', async () => {
  const { win } = fakeWindow({ origin: 'https://app.safe.global.evil.example' });
  await rejects(createSafeClient({ win, timeoutMs: 20 }).getSafeInfo(), /No response/);
});

test('a reply whose source is not the parent is ignored', async () => {
  const { win, deliver } = fakeWindow({ reply: () => null });
  const promise = createSafeClient({ win, timeoutMs: 30 }).getSafeInfo();
  await new Promise((r) => setTimeout(r, 0));
  deliver({ id: '0000000000', success: true, version: SDK_VERSION, data: SAFE_INFO }, { not: 'the parent' });
  await rejects(promise, /No response/);
});

test('a reply without a major version of at least 1 is ignored', async () => {
  for (const version of [undefined, '', '0.9.0', 'x', 1]) {
    const { win } = fakeWindow({ reply: (msg) => ({ id: msg.id, success: true, version, data: SAFE_INFO }) });
    await rejects(createSafeClient({ win, timeoutMs: 20 }).getSafeInfo(), /No response/);
  }
});

test('a non-object reply is ignored rather than throwing', async () => {
  for (const data of [null, 'string', 42]) {
    const { win } = fakeWindow({ reply: () => data });
    await rejects(createSafeClient({ win, timeoutMs: 20 }).getSafeInfo(), /No response/);
  }
});

test('a reply with an unknown id is ignored and does not disturb the pending request', async () => {
  const { win, deliver } = fakeWindow({ reply: () => null });
  const promise = createSafeClient({ win, timeoutMs: 30 }).getSafeInfo();
  await new Promise((r) => setTimeout(r, 0));
  deliver({ id: 'ffffffffff', success: true, version: SDK_VERSION, data: SAFE_INFO }, win.parent);
  await rejects(promise, /No response/);
});

test('an error response rejects with the interface’s own message', async () => {
  const { win } = fakeWindow({
    reply: (msg) => ({ id: msg.id, success: false, version: SDK_VERSION, error: 'Transaction rejected' }),
  });
  await rejects(createSafeClient({ win }).getSafeInfo(), /Transaction rejected/);
});

test('an error response with no message still rejects', async () => {
  const { win } = fakeWindow({ reply: (msg) => ({ id: msg.id, success: false, version: SDK_VERSION }) });
  await rejects(createSafeClient({ win }).getSafeInfo(), /returned an error/);
});

// ── deadlines apply to getSafeInfo only ───────────────────────────────────────────────────────

test('sendTransactions has no deadline: it survives well past the getSafeInfo timeout', async () => {
  // The interface replies to sendTransactions only after an owner has dealt with the signing
  // modal, which can take minutes. A deadline here would reject a batch about to be signed.
  const ids = [];
  const { win, deliver } = fakeWindow({
    reply: (msg) => {
      ids.push(msg.id);
      return null;
    },
  });
  const client = createSafeClient({ win, timeoutMs: 20 });

  const promise = client.sendTransactions([{ to: '0x' + 'a'.repeat(40), value: '1', data: '0x' }]);
  await new Promise((r) => setTimeout(r, 80)); // four times the getSafeInfo deadline

  deliver({ id: ids[0], success: true, version: SDK_VERSION, data: { safeTxHash: '0xdeadbeef' } }, win.parent);
  assert.deepEqual(await promise, { safeTxHash: '0xdeadbeef' });
});

test('getSafeInfo still honours its deadline while a batch is outstanding', async () => {
  const { win } = fakeWindow({ reply: () => null });
  const client = createSafeClient({ win, timeoutMs: 20 });

  client.sendTransactions([]); // left pending on purpose
  await rejects(client.getSafeInfo(), /within 20ms/);
});

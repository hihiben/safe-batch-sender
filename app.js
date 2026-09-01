// Browser wiring. All logic that can be tested without a browser lives in payload.js; all
// protocol handling lives in vendor/safe-client.js. What is left here is the DOM.
//
// Hard rule for this file: no markup-assigning API, anywhere. Every piece of text that comes from
// the link is set with textContent, so a payload can never become markup. The banned identifiers
// are listed in .github/workflows/ci.yml, which fails the build if any of them appears in the
// source — that grep is kept literal and exception-free, which is why they are not named here.

import {
  CHAINS,
  PayloadError,
  checkChain,
  checkSafe,
  formatUnits,
  parseLink,
  sumWei,
} from './payload.js';
import { SAFE_PARENT_ORIGIN, SafeClientError, createSafeClient } from './vendor/safe-client.js';

const byId = (id) => document.getElementById(id);

/** @param {string} tag @param {string|number} [text] */
const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  return node;
};

const withClass = (node, className) => {
  node.className = className;
  return node;
};

const show = (section) => {
  section.hidden = false;
  return section;
};

const setStatus = (text) => {
  byId('status').textContent = text;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The only way this app declines to act. Verification rule failures land here, and the send button
 * is simply never created — no warning to click past, no override.
 */
const refuse = (reason) => {
  byId('refusal-reason').textContent = reason;
  show(byId('refusal'));
  setStatus('Refused.');
};

const messageOf = (error, fallback) =>
  error instanceof PayloadError || error instanceof SafeClientError ? error.message : fallback;

// ── rendering ─────────────────────────────────────────────────────────────────────────────────

/** A definition list of plain facts. Values are text nodes; none of them is ever parsed. */
const facts = (rows) => {
  const dl = withClass(el('dl'), 'facts');
  for (const [term, value, extraClass] of rows) {
    dl.append(el('dt', term));
    const dd = el('dd', value);
    if (extraClass) dd.className = extraClass;
    dl.append(dd);
  }
  return dl;
};

/**
 * The batch itself, rendered before we know anything about the connected Safe. Showing it
 * unconditionally is deliberate: if this page is opened outside Safe, the operator can still read
 * what the link contains, which is how a suspicious link gets inspected.
 */
const renderBatch = (payload) => {
  const chain = CHAINS[payload.chainId];
  const section = byId('batch');
  const total = sumWei(payload.txs.map((tx) => tx.value));

  if (payload.label !== '') {
    section.append(withClass(el('p', payload.label), 'label'));
  }

  section.append(
    facts([
      ['Chain', `${chain.name} (chain ID ${payload.chainId})`],
      ['Safe', payload.safe, 'mono'],
      ['Transactions', plural(payload.txs.length, 'native transfer', 'native transfers')],
      ['Total', `${formatUnits(total)} ${chain.symbol}`],
    ]),
  );

  section.append(el('h3', 'Recipients'));

  const table = el('table');
  const head = el('thead');
  const headRow = el('tr');
  headRow.append(withClass(el('th', '#'), 'num'), el('th', 'Recipient'));
  headRow.append(withClass(el('th', chain.symbol), 'num'), withClass(el('th', 'wei'), 'num'));
  head.append(headRow);
  table.append(head);

  const body = el('tbody');
  payload.txs.forEach((tx, i) => {
    const row = el('tr');
    row.append(withClass(el('td', i + 1), 'num'));
    row.append(withClass(el('td', tx.to), 'mono'));
    row.append(withClass(el('td', formatUnits(tx.value)), 'num'));
    row.append(withClass(el('td', tx.value), 'num mono'));
    body.append(row);
  });
  table.append(body);

  const foot = el('tfoot');
  const footRow = el('tr');
  footRow.append(el('td', ''), el('td', 'Total'));
  footRow.append(withClass(el('td', formatUnits(total)), 'num'));
  footRow.append(withClass(el('td', total), 'num mono'));
  foot.append(footRow);
  table.append(foot);

  const scroller = withClass(el('div'), 'scroll');
  scroller.append(table);
  section.append(scroller);
  show(section);
};

/** Verification rule 1 failed: we are not inside the Safe interface. Read-only, no button. */
const renderOutsideSafe = (error) => {
  const section = byId('checks');
  const panel = withClass(el('section'), 'panel panel-warn');
  panel.append(el('h2', 'Read-only: this page is not running inside Safe'));
  panel.append(
    el(
      'p',
      'The batch above is shown for inspection only. Nothing can be proposed from here, because ' +
        'the app never got a reply from the Safe interface.',
    ),
  );
  panel.append(el('p', `Reason: ${messageOf(error, 'the Safe interface did not respond.')}`));
  panel.append(
    el('p', `Open this batch from the link the /topup-gastank command produced, which loads it inside ${SAFE_PARENT_ORIGIN}.`),
  );
  section.append(panel);
  show(section);
  setStatus('Read-only.');
};

/** Rules 1, 3 and 4 all passed. State what was checked, and what was not. */
const renderChecks = (payload, safeInfo) => {
  const chain = CHAINS[payload.chainId];
  const section = byId('checks');

  const ok = withClass(el('section'), 'panel panel-ok');
  ok.append(el('h2', 'Checked against the connected Safe'));
  ok.append(
    facts([
      ['Chain', `${chain.name} (${payload.chainId}) — matches`, 'tick'],
      ['Safe', `${safeInfo.safeAddress} — matches`, 'tick'],
      ['Signatures needed', `${safeInfo.threshold ?? '?'} of ${plural(safeInfo.owners?.length ?? 0, 'owner', 'owners')}`],
    ]),
  );
  section.append(ok);

  // The recipient allowlist was removed from the design, so nothing here constrains who gets paid.
  // Say so plainly on the screen that carries the button, rather than only in the README.
  const warn = withClass(el('section'), 'panel panel-warn');
  warn.append(el('h2', 'What this app does not check'));
  warn.append(
    el(
      'p',
      'Recipients are not checked against any list. Anyone able to put a link in front of an owner ' +
        'can name any recipient, and this app will display it exactly as it displays a real batch.',
    ),
  );
  warn.append(el('p', 'Read every address and amount above, then read them again in Safe’s signing modal.'));
  section.append(warn);

  show(section);
};

const queueUrl = (payload) =>
  `${SAFE_PARENT_ORIGIN}/transactions/queue?safe=${CHAINS[payload.chainId].prefix}:${payload.safe}`;

const renderResult = (payload, safeTxHash) => {
  const section = byId('result');
  section.replaceChildren();
  section.append(el('h2', 'Proposed'));
  section.append(facts([['safeTxHash', safeTxHash, 'mono']]));

  const p = el('p');
  const link = el('a', 'Open the Safe transaction queue');
  link.href = queueUrl(payload);
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  p.append(link, ' to sign and execute it.');
  section.append(p);

  show(section);
  setStatus('Proposed. Signing happens in Safe.');
};

/** The send button. Created only after every verification rule has passed. */
const renderActions = (payload, client) => {
  const section = byId('actions');
  const button = el('button', `Propose ${plural(payload.txs.length, 'transaction', 'transactions')} to Safe`);
  button.type = 'button';

  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus('Waiting for Safe’s signing modal…');
    byId('result').hidden = true;

    try {
      // `data: '0x'` — a plain native transfer. BaseTransaction requires the field.
      const { safeTxHash } = await client.sendTransactions(
        payload.txs.map(({ to, value }) => ({ to, value, data: '0x' })),
      );
      renderResult(payload, safeTxHash);
    } catch (error) {
      setStatus(`Not proposed: ${messageOf(error, 'the Safe interface rejected the batch.')}`);
      button.disabled = false;
    }
  });

  section.append(button);
  section.append(
    withClass(el('p', 'This proposes the batch to Safe. It is not signed or executed until an owner does so in Safe.'), 'hint'),
  );
  show(section);
};

// ── the verification sequence from the design’s §6 ────────────────────────────────────────────
// Rule 5 is absent on purpose: the recipient allowlist was removed. See README.md.

const main = async () => {
  let payload;
  try {
    payload = parseLink(window.location.hash); // rule 2, and rule 6 inside it
  } catch (error) {
    refuse(messageOf(error, 'The link could not be read.'));
    return;
  }

  renderBatch(payload);
  setStatus('Checking the connected Safe…');

  const client = createSafeClient();

  let safeInfo;
  try {
    safeInfo = await client.getSafeInfo(); // rule 1
  } catch (error) {
    renderOutsideSafe(error);
    return;
  }

  try {
    checkChain(payload, safeInfo); // rule 3
    checkSafe(payload, safeInfo); // rule 4
  } catch (error) {
    refuse(messageOf(error, 'The batch does not match the connected Safe.'));
    return;
  }

  if (safeInfo.isReadOnly) {
    // Not a refusal — the design lists six rules and this is not one of them. But proposing from
    // an account that is not an owner will fail in the interface, so say it before the click.
    const note = withClass(el('section'), 'panel panel-warn');
    note.append(el('h2', 'Connected as a watcher'));
    note.append(el('p', 'Safe reports this session as read-only, so proposing will likely be rejected. Connect an owner account.'));
    byId('checks').append(note);
  }

  renderChecks(payload, safeInfo);
  renderActions(payload, client);
  setStatus(`Verified. ${plural(payload.txs.length, 'transaction', 'transactions')} ready to propose.`);
};

main().catch((error) => {
  // Nothing below rule 4 should be able to throw, but a page frozen on "Checking…" is
  // indistinguishable from a slow one, and this app must never look like it is still working.
  refuse(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
});

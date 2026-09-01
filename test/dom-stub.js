// A DOM small enough to read and large enough to run app.js under `node --test`.
//
// It implements exactly the surface app.js touches — createElement, textContent, className, append,
// replaceChildren, hidden, addEventListener, and a few attributes. Nothing here does layout or CSS;
// what it verifies is which nodes get built, what text they carry, and crucially whether the send
// button exists.
//
// It earns its keep: `section.append(el('div')).lastChild.append(table)` looked fine on the page
// and threw on every load, because Node.append() returns undefined.

class StubNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.childNodes = [];
    this.ownText = '';
    this.className = '';
    this.hidden = false;
    this.listeners = new Map();
  }

  set textContent(value) {
    this.ownText = value === null || value === undefined ? '' : String(value);
    this.childNodes = []; // real DOM: assigning textContent replaces all children
  }

  get textContent() {
    const fromChildren = this.childNodes
      .map((c) => (typeof c === 'string' ? c : c.textContent))
      .join('');
    return this.ownText + fromChildren;
  }

  append(...items) {
    for (const item of items) {
      if (item === undefined || item === null) throw new TypeError(`append(${item}) — probably a chained call that returned nothing`);
      this.childNodes.push(item);
    }
    // Deliberately returns undefined, like the real thing.
  }

  replaceChildren(...items) {
    this.ownText = '';
    this.childNodes = items;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  async dispatch(type) {
    for (const fn of this.listeners.get(type) ?? []) await fn();
  }

  /** Every element in this subtree, self included. */
  descendants() {
    const out = [this];
    for (const child of this.childNodes) {
      if (typeof child !== 'string') out.push(...child.descendants());
    }
    return out;
  }

  find(tagName) {
    return this.descendants().filter((n) => n.tagName === tagName);
  }
}

const SECTION_IDS = ['status', 'refusal', 'refusal-reason', 'batch', 'checks', 'actions', 'result'];

/**
 * Installs globals and returns handles. Call before importing app.js.
 *
 * @param {object} o
 * @param {string} o.hash - what window.location.hash returns
 * @param {null|((req: object) => object|null)} [o.reply] - the fake Safe interface; null stays silent
 */
export function installDom({ hash, reply }) {
  const byId = new Map(SECTION_IDS.map((id) => [id, new StubNode(id === 'status' ? 'p' : 'section')]));
  // index.html starts every filled region hidden.
  for (const [id, node] of byId) node.hidden = id !== 'status';
  // ...and #refusal-reason is a child of #refusal there, so reading the refusal region has to
  // reach the reason text. Without this the stub silently loses every refusal message.
  byId.get('refusal').append(byId.get('refusal-reason'));

  const document = {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tagName) => new StubNode(tagName),
  };

  const messageListeners = [];
  const posted = [];
  const window = {
    location: { hash },
    crypto: globalThis.crypto,
    addEventListener: (type, fn) => {
      if (type === 'message') messageListeners.push(fn);
    },
  };

  const deliver = (data) => {
    for (const fn of messageListeners) fn({ source: window.parent, origin: 'https://app.safe.global', data });
  };

  window.parent = {
    postMessage: (msg) => {
      posted.push(msg);
      const response = reply === undefined ? null : reply(msg);
      if (response) setTimeout(() => deliver(response), 0);
    },
  };

  globalThis.document = document;
  globalThis.window = window;

  return {
    byId,
    posted,
    deliver,
    /** Text of a whole region, whitespace-normalised. */
    text: (id) => byId.get(id).textContent.replace(/\s+/g, ' ').trim(),
    /** The send button, or null. Its absence is what a refusal means. */
    button: () => byId.get('actions').find('button')[0] ?? null,
    /** Let pending microtasks and 0ms timers run. */
    settle: (rounds = 6) =>
      new Promise((resolve) => {
        let n = rounds;
        const tick = () => (n-- > 0 ? setTimeout(tick, 0) : resolve());
        tick();
      }),
  };
}

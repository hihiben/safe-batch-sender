// Minimal Safe Apps postMessage client. Hand-written, no dependencies, no build step.
//
// ── Why this is not the real SDK ──────────────────────────────────────────────────────────────
// @safe-global/safe-apps-sdk@9.1.0 ships no browser-consumable build. It is `type: module` with
// only dist/cjs, dist/esm and dist/types: no `browser` field, no UMD/IIFE bundle. dist/esm carries
// bare specifiers a browser cannot resolve — `viem`, `@safe-global/safe-gateway-typescript-sdk`,
// and Node's built-in `util`. Vendoring it therefore means either adding a bundler (this repo has
// no build step, on purpose) or checking in an opaque bundle — which would defeat the reason for
// vendoring, namely that the code in this repo is auditable and diffable.
//
// So this file implements the two methods this app needs, transcribed from Safe's own source.
//
// ── Provenance ────────────────────────────────────────────────────────────────────────────────
// App side — @safe-global/safe-apps-sdk v9.1.0:
//   src/communication/index.ts             request/response plumbing, incoming-message validation
//   src/communication/messageFormatter.ts  request envelope: { id, method, params, env }
//   src/communication/utils.ts             request id: 5 random bytes as 10 hex chars
//   src/communication/methods.ts           method names
//   src/safe/index.ts                      getSafeInfo
//   src/txs/index.ts                       sendTransactions params
// Interface side — safe-global/safe-wallet-monorepo @ dev:
//   apps/web/src/services/safe-apps/AppCommunicator.ts   response envelope and its own checks
//   apps/web/src/components/safe-apps/AppFrame/SafeAppIframe.tsx   iframe sandbox attributes
//
// Worth knowing, because the design document assumed otherwise: there is NO handshake and no
// two-way version negotiation. The app posts a request and matches the reply by id. The interface
// validates `event.source`, `event.origin` and the method name, and does NOT look at the
// `env.sdkVersion` we send. The only version check in the protocol runs in this direction: the
// interface stamps each response with its own SDK version, and the SDK requires major >= 1.
//
// ── Two deliberate differences from the SDK ───────────────────────────────────────────────────
// 1. Requests can time out. The SDK's promise never settles when nothing answers, so with it "are
//    we inside a Safe iframe?" is a question that cannot be answered. This app needs that answer
//    (verification rule 1), so getSafeInfo carries a deadline.
//
//    sendTransactions deliberately does NOT. The interface answers it only after an owner has
//    finished with the signing modal, which can take minutes; any deadline short enough to be
//    useful for rule 1 would reject a batch that is about to be signed.
// 2. The parent origin is pinned. The SDK defaults to allowedOrigins = null and checks only
//    event.source; it also posts with targetOrigin '*'. This client checks event.origin and posts
//    to the pinned origin. SAFE_PARENT_ORIGIN is the single place that value is written — index.html
//    repeats it in its CSP frame-ancestors directive, and the two must stay equal.
//
//    Note that the CSP directive is advisory here: frame-ancestors is ignored when a policy is
//    delivered in a <meta> element, and GitHub Pages cannot set response headers. The enforcement
//    that actually holds is the origin check below.

/** The only origin allowed to embed this app and exchange messages with it. */
export const SAFE_PARENT_ORIGIN = 'https://app.safe.global';

/** Reported in env.sdkVersion. The interface does not validate it; we send a truthful value. */
export const SDK_VERSION = '9.1.0';

/**
 * Deadline for the one request that has to have one. Long enough for a slow interface, short
 * enough that loading this page outside a Safe fails visibly rather than spinning.
 */
export const HANDSHAKE_TIMEOUT_MS = 8000;

export class SafeClientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafeClientError';
  }
}

const requestId = (win) => {
  const bytes = new Uint8Array(5); // SDK: generateId(10) -> Uint8Array(10/2) -> 10 hex chars
  win.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * @param {object} [opts]
 * @param {Window} [opts.win] - injectable for tests; defaults to the real window
 * @param {string} [opts.parentOrigin]
 * @param {number} [opts.timeoutMs] - deadline for getSafeInfo; sendTransactions never expires
 */
export function createSafeClient({
  win = globalThis.window,
  parentOrigin = SAFE_PARENT_ORIGIN,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
} = {}) {
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map();

  win.addEventListener('message', (event) => {
    if (event.source !== win.parent) return;
    if (event.origin !== parentOrigin) return;

    const data = event.data;
    if (data === null || typeof data !== 'object') return;

    // Mirrors the SDK: every response the interface sends is stamped with its SDK version, and a
    // message without a major version of at least 1 is not part of this protocol.
    const major = typeof data.version === 'string' ? Number.parseInt(data.version.split('.')[0], 10) : NaN;
    if (!Number.isInteger(major) || major < 1) return;

    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);

    if (data.success) {
      entry.resolve(data.data);
    } else {
      entry.reject(new SafeClientError(typeof data.error === 'string' ? data.error : 'The Safe interface returned an error.'));
    }
  });

  /** @param {number|null} deadlineMs - null means wait indefinitely */
  const send = (method, params, deadlineMs) =>
    new Promise((resolve, reject) => {
      if (win.parent === win) {
        // Top-level load. The SDK would post a message to itself and wait forever.
        reject(new SafeClientError('Not running inside an iframe.'));
        return;
      }

      const id = requestId(win);
      const timer = deadlineMs === null
        ? null
        : setTimeout(() => {
            pending.delete(id);
            reject(new SafeClientError(`No response from the Safe interface within ${deadlineMs}ms.`));
          }, deadlineMs);

      pending.set(id, { resolve, reject, timer });
      win.parent.postMessage({ id, method, params, env: { sdkVersion: SDK_VERSION } }, parentOrigin);
    });

  return {
    /**
     * Verification rule 1 rests on this: a reply proves we are inside the Safe interface, and the
     * deadline turns "no reply" into an answer instead of an indefinite wait.
     * @returns {Promise<{safeAddress: string, chainId: number, threshold: number, owners: string[], isReadOnly: boolean}>}
     */
    getSafeInfo: () => send('getSafeInfo', undefined, timeoutMs),

    /**
     * Proposes a batch. Signing and execution happen entirely in the Safe interface afterwards.
     * No deadline: the interface replies only once an owner has dealt with the signing modal.
     * @param {Array<{to: string, value: string, data: string}>} txs
     * @returns {Promise<{safeTxHash: string}>}
     */
    sendTransactions: (txs) => send('sendTransactions', { txs }, null),
  };
}

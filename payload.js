// Pure payload functions: decode, validate, format. No DOM, no network, no dependencies.
//
// Kept separate from app.js so the same code runs under `node --test` (see test/payload.test.js).
// Everything here is a total function of its arguments; the browser-only wiring lives in app.js.

/**
 * The six chains the gas tanks live on. Chain IDs and EIP-3770 prefixes are the ones
 * gas-refill-util's GenerateGas.js already uses; native symbols come from its CheckState.js.
 */
export const CHAINS = {
  '1': { name: 'Ethereum', prefix: 'eth', symbol: 'ETH' },
  '56': { name: 'BNB Smart Chain', prefix: 'bnb', symbol: 'BNB' },
  '100': { name: 'Gnosis', prefix: 'gno', symbol: 'xDAI' },
  '4663': { name: 'Robinhood Chain', prefix: 'robinhood', symbol: 'ETH' },
  '8453': { name: 'Base', prefix: 'base', symbol: 'ETH' },
  '42161': { name: 'Arbitrum One', prefix: 'arb1', symbol: 'ETH' },
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Verification rule 6: a non-zero positive integer, as a decimal string. No sign, no exponent,
// no leading zero, no decimal point. Amounts are always wei.
const WEI_RE = /^[1-9][0-9]*$/;

const TOP_LEVEL_KEYS = ['v', 'chainId', 'safe', 'label', 'txs'];

/** Thrown for every refusal, so callers can render `.message` and nothing else. */
export class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadError';
  }
}

/**
 * base64url -> UTF-8 -> JSON.
 *
 * Deliberately not bare `atob`: that yields one char per byte, so any multi-byte UTF-8 in `label`
 * comes out mojibake. The bytes go through TextDecoder in fatal mode instead, which rejects
 * invalid UTF-8 rather than substituting U+FFFD.
 *
 * @param {string} fragment - `location.hash`, with or without the leading '#'
 * @returns {unknown} - whatever the JSON decoded to; validate it before trusting it
 */
export function decodeFragment(fragment) {
  const raw = String(fragment ?? '').replace(/^#/, '').trim();
  if (raw === '') {
    throw new PayloadError('This link carries no batch. Open it from the /topup-gastank Slack command.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new PayloadError('The link payload is not valid base64url.');
  }

  const base64 = raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(raw.length / 4) * 4, '=');

  let bytes;
  try {
    const binary = atob(base64);
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    throw new PayloadError('The link payload is not valid base64url.');
  }

  let json;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PayloadError('The link payload is not valid UTF-8.');
  }

  try {
    return JSON.parse(json);
  } catch {
    throw new PayloadError('The link payload is not valid JSON.');
  }
}

/**
 * Verification rule 2: schema check. Strict — an unknown key is a refusal, not something to
 * ignore, because a field we silently drop is a field an attacker can hide meaning in.
 *
 * @param {unknown} raw
 * @returns {{v: 1, chainId: string, safe: string, label: string, txs: Array<{to: string, value: string}>}}
 */
export function validatePayload(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PayloadError('The link payload is not a JSON object.');
  }

  const unknown = Object.keys(raw).filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new PayloadError(`The link payload carries unrecognised field(s): ${unknown.join(', ')}.`);
  }

  if (raw.v !== 1) {
    throw new PayloadError(`Unsupported payload version: ${JSON.stringify(raw.v)}. This app understands v1.`);
  }

  if (typeof raw.chainId !== 'string' || !Object.prototype.hasOwnProperty.call(CHAINS, raw.chainId)) {
    throw new PayloadError(`Unknown chain ID: ${JSON.stringify(raw.chainId)}.`);
  }

  if (typeof raw.safe !== 'string' || !ADDRESS_RE.test(raw.safe)) {
    throw new PayloadError('The payload’s Safe address is not a 20-byte hex address.');
  }

  // Display-only. Never consulted by any check below, and rendered with textContent.
  if (raw.label !== undefined && typeof raw.label !== 'string') {
    throw new PayloadError('The payload’s label is not a string.');
  }

  if (!Array.isArray(raw.txs) || raw.txs.length === 0) {
    throw new PayloadError('The payload carries no transactions.');
  }

  const txs = raw.txs.map((entry, i) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new PayloadError(`Transaction ${i + 1} is not a [to, wei] pair.`);
    }
    const [to, value] = entry;
    if (typeof to !== 'string' || !ADDRESS_RE.test(to)) {
      throw new PayloadError(`Transaction ${i + 1} has a recipient that is not a 20-byte hex address.`);
    }
    if (typeof value !== 'string' || !WEI_RE.test(value)) {
      throw new PayloadError(
        `Transaction ${i + 1} has an amount that is not a positive integer wei string: ${JSON.stringify(value)}.`,
      );
    }
    return { to, value };
  });

  return { v: 1, chainId: raw.chainId, safe: raw.safe, label: raw.label ?? '', txs };
}

/** Rules 2 and 6 together: decode a fragment into a payload, or throw a PayloadError. */
export function parseLink(fragment) {
  return validatePayload(decodeFragment(fragment));
}

/**
 * Verification rule 3. The payload carries the chain ID as a string; getSafeInfo reports it as a
 * number, so compare through String() rather than ==.
 */
export function checkChain(payload, safeInfo) {
  const connected = String(safeInfo.chainId);
  if (connected !== payload.chainId) {
    const expected = CHAINS[payload.chainId]?.name ?? 'unknown';
    const actual = CHAINS[connected]?.name ?? 'unknown';
    throw new PayloadError(
      `This link is for chain ${payload.chainId} (${expected}), but the connected Safe is on chain ${connected} (${actual}).`,
    );
  }
}

/** Verification rule 4. Addresses compare case-insensitively: EIP-55 casing is not identity. */
export function checkSafe(payload, safeInfo) {
  const connected = String(safeInfo.safeAddress ?? '');
  if (connected.toLowerCase() !== payload.safe.toLowerCase()) {
    throw new PayloadError(
      `This link is for Safe ${payload.safe}, but the connected Safe is ${connected || '(unknown)'}.`,
    );
  }
}

/**
 * Integer wei -> decimal string, by string padding only.
 *
 * Never float. This is the inverse of gas-refill-util's ethToWei(), which exists because
 * (0.1).toFixed(18) is "0.100000000000000006" and that error lands in the wei digits.
 */
export function formatUnits(wei, decimals = 18) {
  const digits = String(wei);
  if (!/^[0-9]+$/.test(digits)) {
    throw new PayloadError(`Not an integer wei string: ${JSON.stringify(wei)}.`);
  }
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=[0-9])/, '');
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}

/** Sum of wei strings, as a wei string. BigInt so a 30-transfer batch cannot lose precision. */
export function sumWei(values) {
  return values.reduce((acc, v) => acc + BigInt(v), 0n).toString();
}

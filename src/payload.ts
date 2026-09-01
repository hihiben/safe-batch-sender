import { getAddress } from 'viem'

export type Result<T, E> = { ok: true; value: T } | { ok: false; errors: E[] }

export type PayloadErrorCode =
  | 'MALFORMED_BASE64'
  | 'MALFORMED_JSON'
  | 'INVALID_SHAPE'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_SAFE_ADDRESS'
  | 'EMPTY_TXS'
  | 'TOO_MANY_TXS'
  | 'UNSUPPORTED_TOKEN'
  | 'INVALID_TX_ADDRESS'
  | 'INVALID_TX_AMOUNT'

export interface PayloadError {
  code: PayloadErrorCode
  message: string
  index?: number
}

export interface NormalizedTx {
  to: string
  amountWei: string
}

export interface BatchPayload {
  v: 1
  chainId: string
  safe: string
  label: string
  txs: NormalizedTx[]
}

/**
 * Wire shape: what the Apps Script helper actually emits — tuples, not objects.
 * Only 2-tuples are accepted today. A 3rd element (token address) is rejected
 * outright rather than silently ignored — see UNSUPPORTED_TOKEN below.
 */
export type WireTx = [to: string, amountWei: string]

/** Observed max batch size is 41 rows; 100 leaves headroom without being unbounded. */
export const MAX_TXS = 100

export interface WirePayload {
  v: 1
  chainId: string
  safe: string
  label: string
  txs: WireTx[]
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/

/**
 * All-lowercase/all-uppercase addresses carry no checksum, so they're normalized.
 * Mixed-case addresses must already satisfy EIP-55, or they're rejected outright —
 * silently "fixing" a bad checksum would defeat the point of a checksum.
 */
function normalizeAddress(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return undefined
  const hex = raw.slice(2)
  const isAllLower = hex === hex.toLowerCase()
  const isAllUpper = hex === hex.toUpperCase()
  const checksummed = getAddress(raw.toLowerCase() as `0x${string}`)
  if (isAllLower || isAllUpper) return checksummed
  return raw === checksummed ? checksummed : undefined
}

function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === 'string' && POSITIVE_INTEGER.test(value)
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function validateWirePayload(raw: unknown): Result<BatchPayload, PayloadError> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ code: 'INVALID_SHAPE', message: 'Payload must be a JSON object' }] }
  }
  const obj = raw as Record<string, unknown>
  const errors: PayloadError[] = []

  if (obj.v !== 1) {
    errors.push({ code: 'UNSUPPORTED_VERSION', message: `Unsupported payload version: ${JSON.stringify(obj.v)}` })
  }

  if (typeof obj.chainId !== 'string' || obj.chainId.length === 0) {
    errors.push({ code: 'INVALID_SHAPE', message: 'chainId must be a non-empty string' })
  }

  const safe = normalizeAddress(obj.safe)
  if (!safe) {
    errors.push({ code: 'INVALID_SAFE_ADDRESS', message: `Invalid safe address: ${JSON.stringify(obj.safe)}` })
  }

  const label = typeof obj.label === 'string' ? obj.label : ''

  if (!Array.isArray(obj.txs) || obj.txs.length === 0) {
    errors.push({ code: 'EMPTY_TXS', message: 'txs must be a non-empty array' })
  } else if (obj.txs.length > MAX_TXS) {
    errors.push({ code: 'TOO_MANY_TXS', message: `txs has ${obj.txs.length} entries, which exceeds the limit of ${MAX_TXS}` })
  }

  const txs: NormalizedTx[] = []
  if (Array.isArray(obj.txs)) {
    obj.txs.forEach((entry: unknown, index: number) => {
      if (Array.isArray(entry) && entry.length === 3) {
        errors.push({ code: 'UNSUPPORTED_TOKEN', message: `txs[${index}]: ERC-20 tokens are not supported yet — remove the third (token address) element`, index })
        return
      }
      if (!Array.isArray(entry) || entry.length !== 2) {
        errors.push({ code: 'INVALID_SHAPE', message: `txs[${index}] must be a [to, amountWei] tuple`, index })
        return
      }
      const [rawTo, rawAmount] = entry as unknown[]

      const to = normalizeAddress(rawTo)
      if (!to) errors.push({ code: 'INVALID_TX_ADDRESS', message: `txs[${index}] has an invalid recipient address: ${JSON.stringify(rawTo)}`, index })

      const amountWei = isPositiveIntegerString(rawAmount) ? rawAmount : undefined
      if (!amountWei) errors.push({ code: 'INVALID_TX_AMOUNT', message: `txs[${index}] has an invalid amount: ${JSON.stringify(rawAmount)}`, index })

      if (to && amountWei) txs.push({ to, amountWei })
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: { v: 1, chainId: obj.chainId as string, safe: safe as string, label, txs },
  }
}

export function decodePayload(fragment: string): Result<BatchPayload, PayloadError> {
  const trimmed = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (trimmed.length === 0) {
    return { ok: false, errors: [{ code: 'MALFORMED_BASE64', message: 'Payload fragment is empty' }] }
  }

  let json: string
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(base64UrlDecode(trimmed))
  } catch {
    return { ok: false, errors: [{ code: 'MALFORMED_BASE64', message: 'Fragment is not valid base64url' }] }
  }

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { ok: false, errors: [{ code: 'MALFORMED_JSON', message: 'Payload is not valid JSON' }] }
  }

  return validateWirePayload(raw)
}

export function encodePayload(payload: WirePayload): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
}

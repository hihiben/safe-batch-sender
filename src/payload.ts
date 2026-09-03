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
  // v2 (binary wire format) additions — see SAFE_BATCH_SENDER_PAYLOAD_V2.md (kept outside this repo, in the operator workspace) §3.
  | 'FRAGMENT_TOO_LONG'
  | 'UNRECOGNIZED_FORMAT'
  | 'TRUNCATED_PAYLOAD'
  | 'TRAILING_BYTES'
  | 'INVALID_CHAIN_ID'
  | 'MALFORMED_LABEL'

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
  v: 1 | 2
  chainId: string
  safe: string
  label: string
  txs: NormalizedTx[]
}

/**
 * Wire shape: what the link generators actually emit — tuples, not objects.
 * Only 2-tuples are accepted today. A 3rd element (token address) is rejected
 * outright rather than silently ignored — see UNSUPPORTED_TOKEN below.
 */
export type WireTx = [to: string, amountWei: string]

/**
 * Observed max batch size is 41 rows. 50 leaves some headroom while staying
 * safely under app.safe.global's real limit: it's served through CloudFront/S3,
 * which rejects any request whose total header section (including the request
 * line, i.e. the URL) exceeds 8192 bytes — measured empirically at ~70 rows
 * (see link-budget.test.ts). A link that hits that limit fails as an opaque S3
 * error page, not anything this app controls, so the cap needs real headroom
 * below it, not just below the observed max batch size.
 */
export const MAX_TXS = 50

export interface WirePayload {
  v: 1
  chainId: string
  safe: string
  label: string
  txs: WireTx[]
}

/**
 * v2 (binary wire format) input for encodePayloadV2. Same decimal-string
 * convention as WireTx for chainId/amountWei — only the wire encoding differs,
 * not what callers pass in. See SAFE_BATCH_SENDER_PAYLOAD_V2.md (kept outside this repo, in the operator workspace) §1.
 */
export interface BatchInput {
  chainId: string
  safe: string
  label: string
  txs: WireTx[]
}

/**
 * v2 wire-format constants. Any second implementation of this format has to use
 * the same values (SAFE_BATCH_SENDER_PAYLOAD_V2.md (kept outside this repo, in the operator workspace) §1). MAX_TXS above is
 * shared with v1 and unchanged.
 */
const V2_MARKER = 0x02
/** Encoder-only rule (link budget, not a decode rule) — labelLen itself allows 0..255. */
export const MAX_LABEL_BYTES = 64
export const MAX_CHAIN_ID_BYTES = 8
/** uint256 ceiling for a Safe tx `value`. */
export const MAX_AMOUNT_BYTES = 32
/** Pre-decode guard, checked before base64 decoding, both versions. */
export const MAX_FRAGMENT_CHARS = 16384

const POSITIVE_INTEGER = /^[1-9][0-9]*$/

/**
 * All-lowercase/all-uppercase addresses carry no checksum, so they're normalized.
 * Mixed-case addresses must already satisfy EIP-55, or they're rejected outright —
 * silently "fixing" a bad checksum would defeat the point of a checksum.
 */
export function normalizeAddress(raw: unknown): string | undefined {
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

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const codeUnit = value.charCodeAt(i)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      // charCodeAt past the end is NaN, and NaN fails both comparisons — without the
      // explicit check a high surrogate as the final code unit slips through.
      const next = value.charCodeAt(i + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true
      i++
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }
  return false
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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let hex = '0x'
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex as `0x${string}`
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(bytesToHex(bytes))
}

/**
 * Minimal (no leading zero byte) unsigned big-endian encoding of a positive
 * bigint. `value` must be > 0n — callers validate that first via
 * isPositiveIntegerString, so `value.toString(16)` never starts with a zero
 * nibble pair here.
 */
function bigIntToMinimalBytes(value: bigint): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return hexToBytes(hex)
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

/**
 * v2 binary decoder (SAFE_BATCH_SENDER_PAYLOAD_V2.md (kept outside this repo, in the operator workspace) §1/§3). `bytes[0]`
 * is the V2_MARKER already checked by the decodePayload dispatcher; decoding
 * proper starts at offset 1.
 *
 * Unlike validateWirePayload above (which accumulates every violation it
 * finds), this stops at the FIRST violation and returns a single-element
 * errors array: past a structural violation every subsequent offset is
 * derived from bytes already declared untrustworthy, so there is nothing
 * trustworthy left to keep checking.
 */
function decodeV2(bytes: Uint8Array): Result<BatchPayload, PayloadError> {
  let offset = 1 // skip the marker byte

  function fail(code: PayloadErrorCode, message: string): Result<BatchPayload, PayloadError> {
    return { ok: false, errors: [{ code, message }] }
  }

  function readByte(): number | undefined {
    if (offset + 1 > bytes.length) return undefined
    return bytes[offset++]
  }

  function readBytes(len: number): Uint8Array | undefined {
    if (offset + len > bytes.length) return undefined
    const slice = bytes.subarray(offset, offset + len)
    offset += len
    return slice
  }

  const chainIdLenOffset = offset
  const chainIdLen = readByte()
  if (chainIdLen === undefined) {
    return fail('TRUNCATED_PAYLOAD', `Truncated payload: missing chainIdLen at offset ${chainIdLenOffset}`)
  }
  if (chainIdLen === 0 || chainIdLen > MAX_CHAIN_ID_BYTES) {
    return fail('INVALID_CHAIN_ID', `Invalid chainId length ${chainIdLen} at offset ${chainIdLenOffset}: must be 1..${MAX_CHAIN_ID_BYTES}`)
  }

  const chainIdOffset = offset
  const chainIdBytes = readBytes(chainIdLen)
  if (chainIdBytes === undefined) {
    return fail('TRUNCATED_PAYLOAD', `Truncated payload: expected ${chainIdLen} byte(s) for chainId at offset ${chainIdOffset}`)
  }
  if (chainIdBytes[0] === 0x00) {
    return fail('INVALID_CHAIN_ID', `Invalid chainId at offset ${chainIdOffset}: leading zero byte (not minimally encoded)`)
  }
  const chainId = bytesToBigInt(chainIdBytes).toString()

  const safeOffset = offset
  const safeBytes = readBytes(20)
  if (safeBytes === undefined) {
    return fail('TRUNCATED_PAYLOAD', `Truncated payload: expected 20 byte(s) for safe at offset ${safeOffset}`)
  }
  const safe = getAddress(bytesToHex(safeBytes))

  const labelLenOffset = offset
  const labelLen = readByte()
  if (labelLen === undefined) {
    return fail('TRUNCATED_PAYLOAD', `Truncated payload: missing labelLen at offset ${labelLenOffset}`)
  }

  const labelOffset = offset
  const labelBytes = readBytes(labelLen)
  if (labelBytes === undefined) {
    return fail('TRUNCATED_PAYLOAD', `Truncated payload: expected ${labelLen} byte(s) for label at offset ${labelOffset}`)
  }
  let label: string
  try {
    label = new TextDecoder('utf-8', { fatal: true }).decode(labelBytes)
  } catch {
    return fail('MALFORMED_LABEL', `Malformed label: bytes at offset ${labelOffset} are not valid UTF-8`)
  }

  const nOffset = offset
  const n = readByte()
  if (n === undefined) {
    return fail('TRUNCATED_PAYLOAD', `Truncated payload: missing n at offset ${nOffset}`)
  }
  if (n === 0) {
    return fail('EMPTY_TXS', 'txs must be a non-empty array')
  }
  if (n > MAX_TXS) {
    return fail('TOO_MANY_TXS', `txs has ${n} entries, which exceeds the limit of ${MAX_TXS}`)
  }

  const txs: NormalizedTx[] = []
  for (let index = 0; index < n; index++) {
    const toOffset = offset
    const toBytes = readBytes(20)
    if (toBytes === undefined) {
      return fail('TRUNCATED_PAYLOAD', `Truncated payload: expected 20 byte(s) for txs[${index}].to at offset ${toOffset}`)
    }
    const to = getAddress(bytesToHex(toBytes))

    const amountLenOffset = offset
    const amountLen = readByte()
    if (amountLen === undefined) {
      return fail('TRUNCATED_PAYLOAD', `Truncated payload: missing amountLen for txs[${index}] at offset ${amountLenOffset}`)
    }
    if (amountLen === 0 || amountLen > MAX_AMOUNT_BYTES) {
      return fail('INVALID_TX_AMOUNT', `txs[${index}] has an invalid amount length ${amountLen} at offset ${amountLenOffset}: must be 1..${MAX_AMOUNT_BYTES}`)
    }

    const amountOffset = offset
    const amountBytes = readBytes(amountLen)
    if (amountBytes === undefined) {
      return fail('TRUNCATED_PAYLOAD', `Truncated payload: expected ${amountLen} byte(s) for txs[${index}].amount at offset ${amountOffset}`)
    }
    if (amountBytes[0] === 0x00) {
      return fail('INVALID_TX_AMOUNT', `txs[${index}] has an invalid amount at offset ${amountOffset}: leading zero byte (not minimally encoded)`)
    }

    txs.push({ to, amountWei: bytesToBigInt(amountBytes).toString() })
  }

  if (offset !== bytes.length) {
    return fail('TRAILING_BYTES', `Trailing bytes: ${bytes.length - offset} byte(s) remain after offset ${offset}`)
  }

  return { ok: true, value: { v: 2, chainId, safe, label, txs } }
}

export function decodePayload(fragment: string): Result<BatchPayload, PayloadError> {
  const trimmed = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (trimmed.length === 0) {
    return { ok: false, errors: [{ code: 'MALFORMED_BASE64', message: 'Payload fragment is empty' }] }
  }
  if (trimmed.length > MAX_FRAGMENT_CHARS) {
    return {
      ok: false,
      errors: [{ code: 'FRAGMENT_TOO_LONG', message: `Fragment is ${trimmed.length} characters, which exceeds the limit of ${MAX_FRAGMENT_CHARS}` }],
    }
  }

  let bytes: Uint8Array
  try {
    bytes = base64UrlDecode(trimmed)
  } catch {
    return { ok: false, errors: [{ code: 'MALFORMED_BASE64', message: 'Fragment is not valid base64url' }] }
  }

  // Version dispatch on the first decoded byte (SAFE_BATCH_SENDER_PAYLOAD_V2.md (kept outside this repo, in the operator workspace)
  // §2). Both v1 encoders emit JSON.stringify output, which never starts with
  // whitespace, so a v1 fragment's first byte is always 0x7B ('{'). Binary markers
  // are permanently reserved to 0x01..0x1F, none of which can begin UTF-8 JSON.
  const marker = bytes[0]

  // v1 historically accepts padded standard base64. Keep that compatibility,
  // but v2 has one canonical representation: unpadded base64url only.
  if (marker === V2_MARKER && !/^[A-Za-z0-9_-]*$/.test(trimmed)) {
    return { ok: false, errors: [{ code: 'MALFORMED_BASE64', message: 'Fragment is not valid base64url' }] }
  }

  if (marker === 0x7b) {
    // v1 path, byte-for-byte unchanged from before the dispatcher existed.
    let json: string
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
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

  if (marker === V2_MARKER) {
    return decodeV2(bytes)
  }

  if (marker !== undefined && marker >= 0x01 && marker <= 0x1f) {
    return {
      ok: false,
      errors: [{ code: 'UNSUPPORTED_VERSION', message: `Unsupported payload version marker: 0x${marker.toString(16).padStart(2, '0')}` }],
    }
  }

  return {
    ok: false,
    errors: [
      {
        code: 'UNRECOGNIZED_FORMAT',
        message: marker === undefined ? 'Unrecognized payload format: fragment decoded to zero bytes' : `Unrecognized payload format: first byte 0x${marker.toString(16).padStart(2, '0')}`,
      },
    ],
  }
}

export function encodePayload(payload: WirePayload): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
}

/**
 * v2 binary encoder (SAFE_BATCH_SENDER_PAYLOAD_V2.md (kept outside this repo, in the operator workspace) §1). Throws on any
 * invalid input rather than returning a Result — including a mixed-case
 * address that fails EIP-55, which the wire format has no other way to catch
 * once addresses become raw bytes (decodeV2 above cannot tell a mistyped
 * checksum from a correct one; the encoder is the last checkpoint).
 */
export function encodePayloadV2(input: BatchInput): string {
  if (!isPositiveIntegerString(input.chainId)) {
    throw new Error(`Invalid chainId: ${JSON.stringify(input.chainId)}`)
  }
  const chainIdBytes = bigIntToMinimalBytes(BigInt(input.chainId))
  if (chainIdBytes.length > MAX_CHAIN_ID_BYTES) {
    throw new Error(`chainId ${input.chainId} needs ${chainIdBytes.length} bytes, which exceeds the limit of ${MAX_CHAIN_ID_BYTES}`)
  }

  const safe = normalizeAddress(input.safe)
  if (!safe) {
    throw new Error(`Invalid safe address: ${JSON.stringify(input.safe)}`)
  }

  if (hasLoneSurrogate(input.label)) {
    throw new Error('Label contains a lone surrogate')
  }
  const labelBytes = new TextEncoder().encode(input.label)
  if (labelBytes.length > MAX_LABEL_BYTES) {
    throw new Error(`Label is ${labelBytes.length} bytes, which exceeds the limit of ${MAX_LABEL_BYTES}`)
  }

  if (!Array.isArray(input.txs) || input.txs.length === 0) {
    throw new Error('txs must be a non-empty array')
  }
  if (input.txs.length > MAX_TXS) {
    throw new Error(`txs has ${input.txs.length} entries, which exceeds the limit of ${MAX_TXS}`)
  }

  const rows = input.txs.map((row, index) => {
    const runtimeRow: unknown = row
    if (Array.isArray(runtimeRow) && runtimeRow.length === 3) {
      throw new Error(`txs[${index}]: ERC-20 tokens are not supported yet — remove the third (token address) element`)
    }
    if (!Array.isArray(runtimeRow) || runtimeRow.length !== 2) {
      throw new Error(`txs[${index}] must be a [to, amountWei] tuple`)
    }
    const [rawTo, rawAmount] = runtimeRow

    const to = normalizeAddress(rawTo)
    if (!to) throw new Error(`txs[${index}] has an invalid recipient address: ${JSON.stringify(rawTo)}`)

    if (!isPositiveIntegerString(rawAmount)) {
      throw new Error(`txs[${index}] has an invalid amount: ${JSON.stringify(rawAmount)}`)
    }
    const amountBytes = bigIntToMinimalBytes(BigInt(rawAmount))
    if (amountBytes.length > MAX_AMOUNT_BYTES) {
      throw new Error(`txs[${index}] amount needs ${amountBytes.length} bytes, which exceeds the limit of ${MAX_AMOUNT_BYTES}`)
    }

    return { toBytes: hexToBytes(to), amountBytes }
  })

  const parts: number[] = [V2_MARKER, chainIdBytes.length, ...chainIdBytes, ...hexToBytes(safe), labelBytes.length, ...labelBytes, rows.length]
  for (const row of rows) {
    parts.push(...row.toBytes, row.amountBytes.length, ...row.amountBytes)
  }

  return base64UrlEncode(Uint8Array.from(parts))
}

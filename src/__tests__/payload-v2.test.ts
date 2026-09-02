import { describe, expect, it } from 'vitest'
import { MAX_FRAGMENT_CHARS, MAX_TXS, decodePayload, encodePayloadV2, type BatchInput } from '../payload.js'
import { prepare } from '../prepare.js'
import { GOLDEN_VECTORS } from './payload-v2-vectors.js'

const SAFE = '0xEeFa622109b5E97B98220729Fa35fC037B7B3212'
const A1 = '0x9572561eBe198566bBa3B4e7C53F82Ac27587431'

function base64UrlDecodeForTest(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return new Uint8Array(Buffer.from(padded, 'base64'))
}

function toFragment(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Replaces `deleteCount` bytes starting at `at` with `insert`. Test-only tooling. */
function patch(bytes: Uint8Array, at: number, deleteCount: number, insert: number[] = []): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(bytes.subarray(0, at)), Buffer.from(insert), Buffer.from(bytes.subarray(at + deleteCount))]))
}

interface FieldSpan {
  field: string
  offset: number
  length: number
}

/**
 * Walks a well-formed v2 buffer and records where each field starts and how
 * long it is, so mutation tests can target an exact field boundary instead of
 * a hardcoded magic offset. This is fixture-location tooling only — it does
 * no validation, unlike decodeV2 in payload.ts.
 */
function spansOf(bytes: Uint8Array): FieldSpan[] {
  const spans: FieldSpan[] = []
  let offset = 0
  spans.push({ field: 'marker', offset, length: 1 })
  offset += 1

  const chainIdLenOffset = offset
  const chainIdLen = bytes[chainIdLenOffset]!
  spans.push({ field: 'chainIdLen', offset: chainIdLenOffset, length: 1 })
  offset += 1
  spans.push({ field: 'chainId', offset, length: chainIdLen })
  offset += chainIdLen

  spans.push({ field: 'safe', offset, length: 20 })
  offset += 20

  const labelLenOffset = offset
  const labelLen = bytes[labelLenOffset]!
  spans.push({ field: 'labelLen', offset: labelLenOffset, length: 1 })
  offset += 1
  spans.push({ field: 'label', offset, length: labelLen })
  offset += labelLen

  const nOffset = offset
  const n = bytes[nOffset]!
  spans.push({ field: 'n', offset: nOffset, length: 1 })
  offset += 1

  for (let i = 0; i < n; i++) {
    spans.push({ field: `txs[${i}].to`, offset, length: 20 })
    offset += 20
    const amountLenOffset = offset
    const amountLen = bytes[amountLenOffset]!
    spans.push({ field: `txs[${i}].amountLen`, offset: amountLenOffset, length: 1 })
    offset += 1
    spans.push({ field: `txs[${i}].amount`, offset, length: amountLen })
    offset += amountLen
  }

  return spans
}

function findSpan(spans: FieldSpan[], field: string): FieldSpan {
  const span = spans.find((s) => s.field === field)
  if (!span) throw new Error(`no such field in spans: ${field}`)
  return span
}

const VECTOR_A = GOLDEN_VECTORS.find((v) => v.name.startsWith('A'))!
const VECTOR_B = GOLDEN_VECTORS.find((v) => v.name.startsWith('B'))!
const VECTOR_F = GOLDEN_VECTORS.find((v) => v.name.startsWith('F'))!
const VECTOR_A_BYTES = new Uint8Array(Buffer.from(VECTOR_A.hex, 'hex'))
const VECTOR_B_BYTES = new Uint8Array(Buffer.from(VECTOR_B.hex, 'hex'))
const VECTOR_B_SPANS = spansOf(VECTOR_B_BYTES)

describe.each(GOLDEN_VECTORS)('golden vector $name', (vector) => {
  it('encodePayloadV2(input) reproduces the frozen fragment', () => {
    expect(encodePayloadV2(vector.input)).toBe(vector.fragment)
  })

  it('the assembled bytes hex-match the frozen hex', () => {
    const bytes = base64UrlDecodeForTest(vector.fragment)
    expect(Buffer.from(bytes).toString('hex')).toBe(vector.hex)
  })

  it('decodePayload(fragment) deep-equals the frozen decoded payload', () => {
    const result = decodePayload(vector.fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(vector.decoded)
  })
})

describe('v2 base64 padding parity with v1', () => {
  it('decodes a v2 fragment identically when it carries base64 padding', () => {
    const padded = VECTOR_A.fragment.replace(/-/g, '+').replace(/_/g, '/')
    const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4)
    const result = decodePayload(withPadding)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(VECTOR_A.decoded)
  })
})

describe('MAX_TXS boundary (encode + decode round trip)', () => {
  it('encodes and decodes exactly MAX_TXS rows', () => {
    const txs: [string, string][] = Array.from({ length: MAX_TXS }, () => [A1, '1'])
    const fragment = encodePayloadV2({ chainId: '1', safe: SAFE, label: '', txs })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.txs).toHaveLength(MAX_TXS)
  })

  it('rejects MAX_TXS + 1 rows at encode time', () => {
    const txs: [string, string][] = Array.from({ length: MAX_TXS + 1 }, () => [A1, '1'])
    expect(() => encodePayloadV2({ chainId: '1', safe: SAFE, label: '', txs })).toThrow()
  })
})

describe('round-trip property: chainId x amount width', () => {
  const CHAIN_IDS = ['1', '56', '100', '4663', '8453', '42161']
  const AMOUNT_WIDTHS = [1, 7, 32] as const

  function amountForWidth(width: number): string {
    // 2^(8*(width-1)) has a nonzero leading byte followed by zero bytes, so
    // its minimal big-endian encoding is exactly `width` bytes.
    return (2n ** BigInt(8 * (width - 1))).toString()
  }

  const cases = CHAIN_IDS.flatMap((chainId) => AMOUNT_WIDTHS.map((width) => ({ chainId, width })))

  it.each(cases)('chainId=$chainId, amount width=$width bytes round-trips losslessly', ({ chainId, width }) => {
    const amountWei = amountForWidth(width)
    const input: BatchInput = { chainId, safe: SAFE, label: `w${width}`, txs: [[A1, amountWei]] }
    const fragment = encodePayloadV2(input)
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual({
      v: 2,
      chainId,
      safe: SAFE,
      label: `w${width}`,
      txs: [{ to: A1, amountWei }],
    })
  })
})

describe('encodePayloadV2 rejects invalid input', () => {
  const validBase: BatchInput = { chainId: '1', safe: SAFE, label: '', txs: [[A1, '1']] }

  it.each(['0', '-1', '1.5', '', '1e18', '007'])('rejects amount %j', (amount) => {
    expect(() => encodePayloadV2({ ...validBase, txs: [[A1, amount]] })).toThrow()
  })

  it('rejects a 65-byte label', () => {
    expect(() => encodePayloadV2({ ...validBase, label: 'x'.repeat(65) })).toThrow()
  })

  it('accepts exactly a 64-byte label', () => {
    expect(() => encodePayloadV2({ ...validBase, label: 'x'.repeat(64) })).not.toThrow()
  })

  it('rejects 0 rows', () => {
    expect(() => encodePayloadV2({ ...validBase, txs: [] })).toThrow()
  })

  it('rejects 51 rows', () => {
    const txs: [string, string][] = Array.from({ length: 51 }, () => [A1, '1'])
    expect(() => encodePayloadV2({ ...validBase, txs })).toThrow()
  })

  it('rejects chainId "0"', () => {
    expect(() => encodePayloadV2({ ...validBase, chainId: '0' })).toThrow()
  })

  it('rejects a mixed-case address that fails EIP-55 checksum', () => {
    const badChecksum = '0x9572561EBe198566bBa3B4e7C53F82Ac27587431'
    expect(() => encodePayloadV2({ ...validBase, safe: badChecksum })).toThrow()
  })
})

describe('decodeV2 error taxonomy (mutations of golden vector B)', () => {
  it('rejects a fragment longer than MAX_FRAGMENT_CHARS, before attempting base64 decode', () => {
    const overLong = 'A'.repeat(MAX_FRAGMENT_CHARS + 1)
    const result = decodePayload(overLong)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('FRAGMENT_TOO_LONG')
  })

  it('rejects first byte 0x03 as UNSUPPORTED_VERSION', () => {
    const mutated = patch(VECTOR_A_BYTES, 0, 1, [0x03])
    const result = decodePayload(toFragment(mutated))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('UNSUPPORTED_VERSION')
  })

  it('rejects first byte 0x41 as UNRECOGNIZED_FORMAT', () => {
    const mutated = patch(VECTOR_A_BYTES, 0, 1, [0x41])
    const result = decodePayload(toFragment(mutated))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('UNRECOGNIZED_FORMAT')
  })

  describe('TRUNCATED_PAYLOAD at each field boundary', () => {
    const boundaries = VECTOR_B_SPANS.filter((s) => s.field !== 'marker')

    it.each(boundaries)('rejects a buffer missing $field entirely', ({ offset }) => {
      const truncated = VECTOR_B_BYTES.subarray(0, offset)
      const result = decodePayload(toFragment(truncated))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected error')
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.code).toBe('TRUNCATED_PAYLOAD')
    })

    it.each([
      { field: 'safe', shortBy: 1 },
      { field: 'label', shortBy: 1 },
      { field: 'txs[0].amount', shortBy: 1 },
    ])('rejects a buffer with $field truncated $shortBy byte(s) short', ({ field, shortBy }) => {
      const span = findSpan(VECTOR_B_SPANS, field)
      const truncated = VECTOR_B_BYTES.subarray(0, span.offset + span.length - shortBy)
      const result = decodePayload(toFragment(truncated))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected error')
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.code).toBe('TRUNCATED_PAYLOAD')
    })

    it('names the field and offset in the TRUNCATED_PAYLOAD message', () => {
      const span = findSpan(VECTOR_B_SPANS, 'txs[0].to')
      const truncated = VECTOR_B_BYTES.subarray(0, span.offset)
      const result = decodePayload(toFragment(truncated))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected error')
      expect(result.errors[0]?.message).toContain('txs[0].to')
      expect(result.errors[0]?.message).toContain(String(span.offset))
    })
  })

  it('rejects trailing bytes appended after a complete buffer', () => {
    const withTrailing = patch(VECTOR_B_BYTES, VECTOR_B_BYTES.length, 0, [0xab])
    const result = decodePayload(toFragment(withTrailing))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('TRAILING_BYTES')
  })

  describe('INVALID_CHAIN_ID', () => {
    it('rejects chainIdLen = 0', () => {
      const chainIdLenOffset = findSpan(VECTOR_B_SPANS, 'chainIdLen').offset
      const mutated = patch(VECTOR_B_BYTES, chainIdLenOffset, 1, [0])
      const result = decodePayload(toFragment(mutated))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected error')
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.code).toBe('INVALID_CHAIN_ID')
    })

    it('rejects chainIdLen = 9 (> MAX_CHAIN_ID_BYTES)', () => {
      const chainIdLenOffset = findSpan(VECTOR_B_SPANS, 'chainIdLen').offset
      const mutated = patch(VECTOR_B_BYTES, chainIdLenOffset, 1, [9])
      const result = decodePayload(toFragment(mutated))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected error')
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.code).toBe('INVALID_CHAIN_ID')
    })

    it('rejects a non-minimal chainId (leading zero byte)', () => {
      const chainIdLenOffset = findSpan(VECTOR_B_SPANS, 'chainIdLen').offset
      const chainIdSpan = findSpan(VECTOR_B_SPANS, 'chainId')
      let mutated = patch(VECTOR_B_BYTES, chainIdSpan.offset, 0, [0x00])
      mutated = patch(mutated, chainIdLenOffset, 1, [chainIdSpan.length + 1])
      const result = decodePayload(toFragment(mutated))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected error')
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.code).toBe('INVALID_CHAIN_ID')
    })
  })

  it('rejects a label with invalid UTF-8 bytes', () => {
    const labelSpan = findSpan(VECTOR_B_SPANS, 'label')
    const mutated = patch(VECTOR_B_BYTES, labelSpan.offset, labelSpan.length, Array(labelSpan.length).fill(0x80))
    const result = decodePayload(toFragment(mutated))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('MALFORMED_LABEL')
  })

  it('rejects n = 0 (EMPTY_TXS)', () => {
    const nOffset = findSpan(VECTOR_B_SPANS, 'n').offset
    const mutated = patch(VECTOR_B_BYTES, nOffset, 1, [0])
    const result = decodePayload(toFragment(mutated))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('EMPTY_TXS')
  })

  it.each([51, 255])('rejects n = %i (TOO_MANY_TXS)', (n) => {
    const nOffset = findSpan(VECTOR_B_SPANS, 'n').offset
    const mutated = patch(VECTOR_B_BYTES, nOffset, 1, [n])
    const result = decodePayload(toFragment(mutated))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('TOO_MANY_TXS')
  })

  describe('INVALID_TX_AMOUNT', () => {
    it('rejects amountLen = 0', () => {
      const amountLenOffset = findSpan(VECTOR_B_SPANS, 'txs[0].amountLen').offset
      const mutated = patch(VECTOR_B_BYTES, amountLenOffset, 1, [0])
      const result = decodePayload(toFragment(mutated))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected error')
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.code).toBe('INVALID_TX_AMOUNT')
    })

    it('rejects amountLen = 33 (> MAX_AMOUNT_BYTES)', () => {
      const amountLenOffset = findSpan(VECTOR_B_SPANS, 'txs[0].amountLen').offset
      const mutated = patch(VECTOR_B_BYTES, amountLenOffset, 1, [33])
      const result = decodePayload(toFragment(mutated))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected error')
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.code).toBe('INVALID_TX_AMOUNT')
    })

    it('rejects a non-minimal amount (leading zero byte)', () => {
      const amountLenOffset = findSpan(VECTOR_B_SPANS, 'txs[0].amountLen').offset
      const amountSpan = findSpan(VECTOR_B_SPANS, 'txs[0].amount')
      let mutated = patch(VECTOR_B_BYTES, amountSpan.offset, 0, [0x00])
      mutated = patch(mutated, amountLenOffset, 1, [amountSpan.length + 1])
      const result = decodePayload(toFragment(mutated))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected error')
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.code).toBe('INVALID_TX_AMOUNT')
    })
  })

  it('fail-fast: a buffer with two independent violations returns exactly one error', () => {
    // n = 0 (EMPTY_TXS) is a violation on its own; appending a trailing byte on
    // top adds a second, independent violation (TRAILING_BYTES) that a
    // non-fail-fast decoder might also report. v2 must stop at the first.
    const nOffset = findSpan(VECTOR_B_SPANS, 'n').offset
    let mutated = patch(VECTOR_B_BYTES, nOffset, 1, [0])
    mutated = patch(mutated, mutated.length, 0, [0xab])
    const result = decodePayload(toFragment(mutated))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('EMPTY_TXS')
  })
})

describe('prepare() after v2 decode', () => {
  it('rows and proposed txs describe the same recipients and amounts as the golden vector', () => {
    const result = decodePayload(VECTOR_F.fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')

    const prepared = prepare(result.value, { chainId: result.value.chainId, safe: result.value.safe })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('expected ok')

    expect(prepared.value.rows).toEqual(VECTOR_F.decoded.txs.map((tx) => ({ to: tx.to, amountWei: tx.amountWei })))
    expect(prepared.value.txs).toEqual(VECTOR_F.decoded.txs.map((tx) => ({ to: tx.to, value: tx.amountWei, data: '0x' })))
  })
})

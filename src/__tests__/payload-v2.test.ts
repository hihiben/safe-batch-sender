import { describe, expect, it } from 'vitest'
import { MAX_FRAGMENT_CHARS, MAX_TXS, decodePayload, encodePayloadV2, type BatchInput } from '../payload.js'
import { prepare } from '../prepare.js'
import { GOLDEN_VECTORS } from './payload-v2-vectors.js'

const SAFE = '0x3432931ca9f58f3943cE806039c799F0613871BD'
const A1 = '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14'

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

describe('v2 base64url canonical form', () => {
  it('rejects a v2 fragment that carries standard-base64 characters or padding', () => {
    // Needs a vector whose base64url actually contains - and _, otherwise the rewrite
    // below is a no-op and this test passes without exercising anything. Assert that
    // rather than trusting whichever vector happens to be first.
    const vector = GOLDEN_VECTORS.find((v) => v.fragment.includes('-') && v.fragment.includes('_'))
    if (!vector) throw new Error('no golden vector uses the base64url-specific alphabet')
    const padded = vector.fragment.replace(/-/g, '+').replace(/_/g, '/')
    expect(padded).not.toBe(vector.fragment)
    const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4)
    expect(withPadding).not.toBe(vector.fragment)
    const result = decodePayload(withPadding)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors).toEqual([{ code: 'MALFORMED_BASE64', message: 'Fragment is not valid base64url' }])
  })

  it.each([' ', '\n', '\t'])('rejects ASCII whitespace %j in an unpadded base64url fragment', (whitespace) => {
    const fragment = encodePayloadV2({ chainId: '1', safe: SAFE, label: 'xx', txs: [[A1, '1'], [A1, '1']] })
    expect(fragment.length % 4).toBe(3)
    const at = Math.floor(fragment.length / 2)
    const result = decodePayload(fragment.slice(0, at) + whitespace + fragment.slice(at))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors).toEqual([{ code: 'MALFORMED_BASE64', message: 'Fragment is not valid base64url' }])
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

  // A high surrogate needs a lookahead, so it is the only case that can hide at the end
  // of the string; the first three here are middle/leading, the last four are trailing.
  it.each(['x\ud800y', 'x\udcf0y', '\udc00abc', 'abc\ud800', '\ud800', '\udbff', '\u{1F525}\ud800'])(
    'rejects a label containing a lone surrogate: %j',
    (label) => {
      expect(() => encodePayloadV2({ ...validBase, label })).toThrow(/lone surrogate/i)
    },
  )

  it('still accepts a valid surrogate pair, including as the final code unit', () => {
    expect(() => encodePayloadV2({ ...validBase, label: 'gas \u{1F525}' })).not.toThrow()
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
    const badChecksum = '0x2701232AB142dfF035245dBcaA08e316Bf5d1B14'
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

// A production-shaped fixture, frozen. Unlike golden vectors A-F (largest 138 bytes) this
// one is 904 bytes, which is the only size where a bug in the encoder's three-byte base64
// grouping loop would actually show up.
//
// Provenance: produced by a second implementation of this encoder, in a different
// language and runtime, over 30 synthetic recipients (the first 20 bytes of
// SHA-256 over 'gas-tank-<i>', not real accounts). That is what makes the re-encode
// assertion below a real cross-implementation check rather than this repo agreeing
// with itself.
//
// 904 payload bytes (mod 3 = 1) | 1,206 fragment chars | 30 rows | 23-byte label
// Amounts straddle the 7/8-byte boundary (2^56 - 1) on purpose, 15 of each width: a
// generator that levels every account to one target emits a single width, so only a
// deliberately constructed batch exercises amountLen variation.
//
// Addresses are lowercase in the input because that is what the encoder was handed. v2
// carries raw address bytes, so case never reaches the wire: decodePayload returns them
// checksummed, and re-encoding from either form reproduces this fragment byte for byte.
const PROD_FIXTURE_INPUT: BatchInput = {
  chainId: '8453',
  safe: '0x3432931ca9f58f3943cE806039c799F0613871BD',
  label: "sample production batch",
  txs: [
    ['0x32226adbf9f00eb2a83fe221c0cc4e350ec16b76', '30000000000000000'],
    ['0xbf20c24beeba9c5f5f5efc890e97befdeceb04a4', '33000000000000000'],
    ['0x6ad1766ec2ab368029d42ef67aac94b17ffcd4d3', '36000000000000000'],
    ['0x50d561bd3e543e86a3e92ccc563815f540d0b58f', '39000000000000000'],
    ['0x4328d880533b50fba4e6dbecbc84439904b27a2b', '42000000000000000'],
    ['0x052e9e8d2db17d71d700280ecfa04f55fcb493fe', '45000000000000000'],
    ['0xd3af2062b65d2f71129ee386cd37e0950baf90b3', '48000000000000000'],
    ['0xa469a6f88a561c3095bc2533c47e97916d0be6e0', '51000000000000000'],
    ['0x6ddf1a6daafbbdfac32127d6c846171034d2eafb', '54000000000000000'],
    ['0x6588565d3e1b3d7ad7fb28e730bbb4acfec9787f', '57000000000000000'],
    ['0xb503b5b11b6fbdeaf221bf5874cfb819b84fa6dc', '60000000000000000'],
    ['0x847c231e3c4cc7be26e69c808350bd8440c765dc', '63000000000000000'],
    ['0x40174cf8d610f167df9d62ef2793ff2e98b33895', '66000000000000000'],
    ['0xb3e2c665140fe3a8767e4950f98bc7542a4bc3a3', '69000000000000000'],
    ['0x206f5e532a402a6a710e5a5eb3222de18b7589e9', '72000000000000000'],
    ['0xe4d76b41c76ebe74ee7a0074b98a683eaaba8802', '75000000000000000'],
    ['0x09ea89497f309b23b6e0f85f9f4c29e140b75aa5', '78000000000000000'],
    ['0xf66903c91cfcb5d31cd3e0a5743001a3947d7f91', '81000000000000000'],
    ['0x7b4d3b4ca37f7d64fb7a305c4b35056043fce139', '84000000000000000'],
    ['0x35872e5236755a23d9874c96f93268827628af9d', '87000000000000000'],
    ['0x79c561ee7f39e47f7e4377d0b44d91bcbfc6a79d', '90000000000000000'],
    ['0x7416f6c050fb58edb599c6ce45774618086862b1', '93000000000000000'],
    ['0x4f871a82bb9f2718dbbbe162879de6084044abf7', '96000000000000000'],
    ['0x7a411f2ecc8536e613771f9500dacc6697f332d9', '99000000000000000'],
    ['0x61b5027a4ab1be8c4f6490b06cbf8f17d6cf6913', '102000000000000000'],
    ['0xfaed05acbd839f8e9488e9ddcede4d9ad1426c97', '105000000000000000'],
    ['0x848e1258a5258b534f51bfe12476ab9357949691', '108000000000000000'],
    ['0xc73c027daa26c16e9c832bd504fa12535ff1e3a0', '111000000000000000'],
    ['0x95bd239c2987d1228489000907abe341598ea0f0', '114000000000000000'],
    ['0xca9cbfe6039d1cbca309a728bf45f6b7587b1b53', '117000000000000000'],
  ],
}

const PROD_FIXTURE_FRAGMENT =
  'AgIhBTQykxyp9Y85Q86AYDnHmfBhOHG9F3NhbXBsZSBwcm9kdWN0aW9uIGJhdGNoHjIiatv58A6yqD_iIcDMTjUOwWt2B2qU109DAAC_IMJL7rqcX19e_IkOl7797OsEpAd1PVM9loAAatF2bsKrNoAp1C72eqyUsX_81NMHf-XPK-oAAFDVYb0-VD6Go-kszFY4FfVA0LWPB4qOSxo9gABDKNiAUztQ-6Tm2-y8hEOZBLJ6KweVNscIkQAABS6ejS2xfXHXACgOz6BPVfy0k_4Hn99C9uSAANOvIGK2XS9xEp7jhs034JULr5CzB6qHvuU4AACkaab4ilYcMJW8JTPEfpeRbQvm4Ae1MDrTi4AAbd8abar7vfrDISfWyEYXEDTS6vsHv9i2wd8AAGWIVl0-Gz161_so5zC7tKz-yXh_B8qBMrAygAC1A7WxG2-96vIhv1h0z7gZuE-m3AfVKa6ehgAAhHwjHjxMx74m5pyAg1C9hEDHZdwH39IqjNmAAEAXTPjWEPFn351i7yeT_y6YsziVB-p6pnstAACz4sZlFA_jqHZ-SVD5i8dUKkvDowf1IyJpgIAAIG9eUypAKmpxDlpesyIt4Yt1iekH_8ueV9QAAOTXa0HHbr507noAdLmKaD6quogCCAEKdBpGJ4AACeqJSX8wmyO24Phfn0wp4UC3WqUIARUcljR7AAD2aQPJHPy10xzT4KV0MAGjlH1_kQgBH8USIs6AAHtNO0yjf31k-3owXEs1BWBD_OE5CAEqbY4RIgAANYcuUjZ1WiPZh0yW-TJognYor50IATUWCf91gAB5xWHufznkf35Dd9C0TZG8v8annQgBP76F7ckAAHQW9sBQ-1jttZnGzkV3RhgIaGKxCAFKZwHcHIAAT4cagrufJxjbu-Fih53mCEBEq_cIAVUPfcpwAAB6QR8uzIU25hN3H5UA2sxml_My2QgBX7f5uMOAAGG1AnpKsb6MT2SQsGy_jxfWz2kTCAFqYHWnFwAA-u0FrL2Dn46UiOndzt5NmtFCbJcIAXUI8ZVqgACEjhJYpSWLU09Rv-EkdquTV5SWkQgBf7Ftg74AAMc8An2qJsFunIMr1QT6ElNf8eOgCAGKWelyEYAAlb0jnCmH0SKEiQAJB6vjQVmOoPAIAZUCZWBlAADKnL_mA50cvKMJpyi_Rfa3WHsbUwgBn6rhTriAAA'

const PROD_FIXTURE_DECODED = {
  v: 2 as const,
  chainId: '8453',
  safe: '0x3432931ca9f58f3943cE806039c799F0613871BD',
  label: "sample production batch",
  txs: [
    { to: '0x32226AdBF9F00eb2A83fE221C0Cc4E350Ec16b76', amountWei: '30000000000000000' },
    { to: '0xBF20C24BeeBa9c5f5F5efC890E97BeFDeCeB04A4', amountWei: '33000000000000000' },
    { to: '0x6Ad1766ec2ab368029D42Ef67aac94b17FFcd4d3', amountWei: '36000000000000000' },
    { to: '0x50D561bD3e543E86A3E92ccC563815f540d0b58F', amountWei: '39000000000000000' },
    { to: '0x4328D880533b50fBA4e6DBeCBc84439904B27a2b', amountWei: '42000000000000000' },
    { to: '0x052E9e8d2Db17d71D700280Ecfa04f55fCB493fe', amountWei: '45000000000000000' },
    { to: '0xd3AF2062b65D2F71129eE386CD37e0950baf90B3', amountWei: '48000000000000000' },
    { to: '0xa469A6F88a561c3095Bc2533C47e97916D0bE6e0', amountWei: '51000000000000000' },
    { to: '0x6DdF1A6DAafBbDfac32127d6C846171034d2EAFb', amountWei: '54000000000000000' },
    { to: '0x6588565d3E1b3D7AD7Fb28E730bbb4aCFeC9787f', amountWei: '57000000000000000' },
    { to: '0xB503b5b11B6FBDEaf221Bf5874cfB819B84Fa6Dc', amountWei: '60000000000000000' },
    { to: '0x847c231e3c4cc7Be26E69c808350Bd8440c765DC', amountWei: '63000000000000000' },
    { to: '0x40174cf8D610F167Df9D62eF2793ff2E98B33895', amountWei: '66000000000000000' },
    { to: '0xB3e2c665140FE3a8767E4950f98Bc7542A4Bc3a3', amountWei: '69000000000000000' },
    { to: '0x206f5e532a402a6A710E5A5eB3222dE18b7589E9', amountWei: '72000000000000000' },
    { to: '0xe4D76B41C76Ebe74eE7a0074b98a683eaAba8802', amountWei: '75000000000000000' },
    { to: '0x09EA89497F309b23B6e0F85f9f4C29e140b75aA5', amountWei: '78000000000000000' },
    { to: '0xF66903c91cFcB5d31CD3e0a5743001A3947D7f91', amountWei: '81000000000000000' },
    { to: '0x7B4D3B4cA37f7D64fb7a305c4b35056043fcE139', amountWei: '84000000000000000' },
    { to: '0x35872E5236755a23d9874c96f93268827628AF9d', amountWei: '87000000000000000' },
    { to: '0x79c561EE7F39e47F7E4377D0b44d91BCbfC6A79D', amountWei: '90000000000000000' },
    { to: '0x7416F6c050FB58EdB599c6Ce45774618086862b1', amountWei: '93000000000000000' },
    { to: '0x4f871a82bB9F2718dBbbe162879DE6084044AbF7', amountWei: '96000000000000000' },
    { to: '0x7a411F2Ecc8536e613771F9500Dacc6697f332d9', amountWei: '99000000000000000' },
    { to: '0x61b5027a4AB1bE8C4f6490b06cbf8f17D6CF6913', amountWei: '102000000000000000' },
    { to: '0xFaeD05aCBD839F8E9488E9DdCede4d9ad1426c97', amountWei: '105000000000000000' },
    { to: '0x848e1258a5258b534F51bfe12476AB9357949691', amountWei: '108000000000000000' },
    { to: '0xC73c027DAa26c16E9c832bD504FA12535FF1E3a0', amountWei: '111000000000000000' },
    { to: '0x95bd239c2987d1228489000907ABE341598eA0f0', amountWei: '114000000000000000' },
    { to: '0xca9CbFE6039d1CBcA309a728Bf45f6B7587B1b53', amountWei: '117000000000000000' },
  ],
}

describe('production-shaped fixture from an independent encoder', () => {
  it('decodes the frozen fragment to the expected batch', () => {
    const result = decodePayload('#' + PROD_FIXTURE_FRAGMENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(PROD_FIXTURE_DECODED)
  })

  it('re-encodes to the identical fragment that encoder produced', () => {
    expect(encodePayloadV2(PROD_FIXTURE_INPUT)).toBe(PROD_FIXTURE_FRAGMENT)
  })

  it('is the size and shape the provenance comment claims', () => {
    expect(PROD_FIXTURE_FRAGMENT).toHaveLength(1206)
    expect(base64UrlDecodeForTest(PROD_FIXTURE_FRAGMENT)).toHaveLength(904)
    expect(PROD_FIXTURE_INPUT.txs).toHaveLength(30)
  })
})

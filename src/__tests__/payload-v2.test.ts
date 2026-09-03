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

describe('v2 base64url canonical form', () => {
  it('rejects a v2 fragment that carries standard-base64 characters or padding', () => {
    const padded = VECTOR_A.fragment.replace(/-/g, '+').replace(/_/g, '/')
    const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4)
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

// A production-shaped fixture, frozen. Unlike golden vectors A-F (largest 138 bytes) this
// one is 911 bytes, which is the only size where a bug in the encoder's three-byte base64
// grouping loop would actually show up.
//
// Provenance: produced by a second implementation of this encoder, in a different
// language and runtime, over 30 synthetic recipients (derived from a hash, not real
// accounts), and round-tripped there by a third decoder written from the format
// specification alone. That is what makes the re-encode assertion below a real
// cross-implementation check rather than this repo agreeing with itself.
//
// 911 payload bytes (mod 3 = 2) | 1,215 fragment chars | 1,366 deep-link chars
// 30 rows | 27-byte label | amount widths: 12 x 7 bytes, 18 x 8 bytes | chainId 8453
const PROD_FIXTURE_INPUT: BatchInput = {
  chainId: '8453',
  safe: SAFE,
  label: 'uniswapx gas top-up on base',
  // Lowercase, exactly as buildBatchLink emits them. v2 carries addresses as raw bytes,
  // so case never reaches the wire; the decoded expectation below is checksummed.
  txs: [
    ['0x32226adbf9f00eb2a83fe221c0cc4e350ec16b76', '78239333300000000'],
    ['0xbf20c24beeba9c5f5f5efc890e97befdeceb04a4', '77739333300000000'],
    ['0x6ad1766ec2ab368029d42ef67aac94b17ffcd4d3', '66239333300000000'],
    ['0x50d561bd3e543e86a3e92ccc563815f540d0b58f', '75139333300000000'],
    ['0x4328d880533b50fba4e6dbecbc84439904b27a2b', '28239333300000000'],
    ['0x052e9e8d2db17d71d700280ecfa04f55fcb493fe', '78169333300000000'],
    ['0xd3af2062b65d2f71129ee386cd37e0950baf90b3', '57239333300000000'],
    ['0xa469a6f88a561c3095bc2533c47e97916d0be6e0', '78239333300000000'],
    ['0x6ddf1a6daafbbdfac32127d6c846171034d2eafb', '77739333300000000'],
    ['0x6588565d3e1b3d7ad7fb28e730bbb4acfec9787f', '66239333300000000'],
    ['0xb503b5b11b6fbdeaf221bf5874cfb819b84fa6dc', '75139333300000000'],
    ['0x847c231e3c4cc7be26e69c808350bd8440c765dc', '28239333300000000'],
    ['0x40174cf8d610f167df9d62ef2793ff2e98b33895', '78169333300000000'],
    ['0xb3e2c665140fe3a8767e4950f98bc7542a4bc3a3', '57239333300000000'],
    ['0x206f5e532a402a6a710e5a5eb3222de18b7589e9', '78239333300000000'],
    ['0xe4d76b41c76ebe74ee7a0074b98a683eaaba8802', '77739333300000000'],
    ['0x09ea89497f309b23b6e0f85f9f4c29e140b75aa5', '66239333300000000'],
    ['0xf66903c91cfcb5d31cd3e0a5743001a3947d7f91', '75139333300000000'],
    ['0x7b4d3b4ca37f7d64fb7a305c4b35056043fce139', '28239333300000000'],
    ['0x35872e5236755a23d9874c96f93268827628af9d', '78169333300000000'],
    ['0x79c561ee7f39e47f7e4377d0b44d91bcbfc6a79d', '57239333300000000'],
    ['0x7416f6c050fb58edb599c6ce45774618086862b1', '78239333300000000'],
    ['0x4f871a82bb9f2718dbbbe162879de6084044abf7', '77739333300000000'],
    ['0x7a411f2ecc8536e613771f9500dacc6697f332d9', '66239333300000000'],
    ['0x61b5027a4ab1be8c4f6490b06cbf8f17d6cf6913', '75139333300000000'],
    ['0xfaed05acbd839f8e9488e9ddcede4d9ad1426c97', '28239333300000000'],
    ['0x848e1258a5258b534f51bfe12476ab9357949691', '78169333300000000'],
    ['0xc73c027daa26c16e9c832bd504fa12535ff1e3a0', '57239333300000000'],
    ['0x95bd239c2987d1228489000907abe341598ea0f0', '78239333300000000'],
    ['0xca9cbfe6039d1cbca309a728bf45f6b7587b1b53', '77739333300000000'],
  ],
}

const PROD_FIXTURE_FRAGMENT =
  'AgIhBe76YiEJtel7mCIHKfo1_AN7ezISG3VuaXN3YXB4IGdhcyB0b3AtdXAgb24gYmFzZR4yImrb-fAOsqg_4iHAzE41DsFrdggBFfZCVM9VAL8gwkvuupxfX178iQ6Xvv3s6wSkCAEUL4MCbBUAatF2bsKrNoAp1C72eqyUsX_81NMH61RSm4FVAFDVYb0-VD6Go-kszFY4FfVA0LWPCAEK8tNWAZUAQyjYgFM7UPuk5tvsvIRDmQSyeisHZFOGJgpVAAUuno0tsX1x1wAoDs-gT1X8tJP-CAEVtpgvrPUA068gYrZdL3ESnuOGzTfglQuvkLMHy1re0IbVAKRppviKVhwwlbwlM8R-l5FtC-bgCAEV9kJUz1UAbd8abar7vfrDISfWyEYXEDTS6vsIARQvgwJsFQBliFZdPhs9etf7KOcwu7Ss_sl4fwfrVFKbgVUAtQO1sRtvveryIb9YdM-4GbhPptwIAQry01YBlQCEfCMePEzHvibmnICDUL2EQMdl3AdkU4YmClUAQBdM-NYQ8WffnWLvJ5P_LpizOJUIARW2mC-s9QCz4sZlFA_jqHZ-SVD5i8dUKkvDowfLWt7QhtUAIG9eUypAKmpxDlpesyIt4Yt1iekIARX2QlTPVQDk12tBx26-dO56AHS5img-qrqIAggBFC-DAmwVAAnqiUl_MJsjtuD4X59MKeFAt1qlB-tUUpuBVQD2aQPJHPy10xzT4KV0MAGjlH1_kQgBCvLTVgGVAHtNO0yjf31k-3owXEs1BWBD_OE5B2RThiYKVQA1hy5SNnVaI9mHTJb5MmiCdiivnQgBFbaYL6z1AHnFYe5_OeR_fkN30LRNkby_xqedB8ta3tCG1QB0FvbAUPtY7bWZxs5Fd0YYCGhisQgBFfZCVM9VAE-HGoK7nycY27vhYoed5ghARKv3CAEUL4MCbBUAekEfLsyFNuYTdx-VANrMZpfzMtkH61RSm4FVAGG1AnpKsb6MT2SQsGy_jxfWz2kTCAEK8tNWAZUA-u0FrL2Dn46UiOndzt5NmtFCbJcHZFOGJgpVAISOElilJYtTT1G_4SR2q5NXlJaRCAEVtpgvrPUAxzwCfaomwW6cgyvVBPoSU1_x46AHy1re0IbVAJW9I5wph9EihIkACQer40FZjqDwCAEV9kJUz1UAypy_5gOdHLyjCacov0X2t1h7G1MIARQvgwJsFQA'

const PROD_FIXTURE_DECODED = {
  v: 2 as const,
  chainId: '8453',
  safe: SAFE,
  label: 'uniswapx gas top-up on base',
  txs: [
    { to: '0x32226AdBF9F00eb2A83fE221C0Cc4E350Ec16b76', amountWei: '78239333300000000' },
    { to: '0xBF20C24BeeBa9c5f5F5efC890E97BeFDeCeB04A4', amountWei: '77739333300000000' },
    { to: '0x6Ad1766ec2ab368029D42Ef67aac94b17FFcd4d3', amountWei: '66239333300000000' },
    { to: '0x50D561bD3e543E86A3E92ccC563815f540d0b58F', amountWei: '75139333300000000' },
    { to: '0x4328D880533b50fBA4e6DBeCBc84439904B27a2b', amountWei: '28239333300000000' },
    { to: '0x052E9e8d2Db17d71D700280Ecfa04f55fCB493fe', amountWei: '78169333300000000' },
    { to: '0xd3AF2062b65D2F71129eE386CD37e0950baf90B3', amountWei: '57239333300000000' },
    { to: '0xa469A6F88a561c3095Bc2533C47e97916D0bE6e0', amountWei: '78239333300000000' },
    { to: '0x6DdF1A6DAafBbDfac32127d6C846171034d2EAFb', amountWei: '77739333300000000' },
    { to: '0x6588565d3E1b3D7AD7Fb28E730bbb4aCFeC9787f', amountWei: '66239333300000000' },
    { to: '0xB503b5b11B6FBDEaf221Bf5874cfB819B84Fa6Dc', amountWei: '75139333300000000' },
    { to: '0x847c231e3c4cc7Be26E69c808350Bd8440c765DC', amountWei: '28239333300000000' },
    { to: '0x40174cf8D610F167Df9D62eF2793ff2E98B33895', amountWei: '78169333300000000' },
    { to: '0xB3e2c665140FE3a8767E4950f98Bc7542A4Bc3a3', amountWei: '57239333300000000' },
    { to: '0x206f5e532a402a6A710E5A5eB3222dE18b7589E9', amountWei: '78239333300000000' },
    { to: '0xe4D76B41C76Ebe74eE7a0074b98a683eaAba8802', amountWei: '77739333300000000' },
    { to: '0x09EA89497F309b23B6e0F85f9f4C29e140b75aA5', amountWei: '66239333300000000' },
    { to: '0xF66903c91cFcB5d31CD3e0a5743001A3947D7f91', amountWei: '75139333300000000' },
    { to: '0x7B4D3B4cA37f7D64fb7a305c4b35056043fcE139', amountWei: '28239333300000000' },
    { to: '0x35872E5236755a23d9874c96f93268827628AF9d', amountWei: '78169333300000000' },
    { to: '0x79c561EE7F39e47F7E4377D0b44d91BCbfC6A79D', amountWei: '57239333300000000' },
    { to: '0x7416F6c050FB58EdB599c6Ce45774618086862b1', amountWei: '78239333300000000' },
    { to: '0x4f871a82bB9F2718dBbbe162879DE6084044AbF7', amountWei: '77739333300000000' },
    { to: '0x7a411F2Ecc8536e613771F9500Dacc6697f332d9', amountWei: '66239333300000000' },
    { to: '0x61b5027a4AB1bE8C4f6490b06cbf8f17D6CF6913', amountWei: '75139333300000000' },
    { to: '0xFaeD05aCBD839F8E9488E9DdCede4d9ad1426c97', amountWei: '28239333300000000' },
    { to: '0x848e1258a5258b534F51bfe12476AB9357949691', amountWei: '78169333300000000' },
    { to: '0xC73c027DAa26c16E9c832bD504FA12535FF1E3a0', amountWei: '57239333300000000' },
    { to: '0x95bd239c2987d1228489000907ABE341598eA0f0', amountWei: '78239333300000000' },
    { to: '0xca9CbFE6039d1CBcA309a728Bf45f6B7587B1b53', amountWei: '77739333300000000' },
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
    expect(PROD_FIXTURE_FRAGMENT).toHaveLength(1215)
    expect(base64UrlDecodeForTest(PROD_FIXTURE_FRAGMENT)).toHaveLength(911)
    expect(PROD_FIXTURE_INPUT.txs).toHaveLength(30)
  })
})

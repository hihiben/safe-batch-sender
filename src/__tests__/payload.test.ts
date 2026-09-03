import { describe, expect, it } from 'vitest'
import { MAX_TXS, decodePayload, encodePayload } from '../payload.js'

const SAMPLE_FRAGMENT =
  'eyJ2IjoxLCJjaGFpbklkIjoiNDY2MyIsInNhZmUiOiIweDM0MzI5MzFjYTlmNThmMzk0M2NFODA2MDM5Yzc5OUYwNjEzODcxQkQiLCJsYWJlbCI6IiIsInR4cyI6W1siMHgyNzAxMjMyYWIxNDJkZkYwMzUyNDVkQmNhQTA4ZTMxNkJmNWQxQjE0IiwiNTAwMDAwMDAwMDAwMDAwIl1dfQ'

const SAMPLE_DECODED = {
  v: 1,
  chainId: '4663',
  safe: '0x3432931ca9f58f3943cE806039c799F0613871BD',
  label: '',
  txs: [{ to: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', amountWei: '500000000000000' }],
}

// A frozen v1 fragment, produced by a second implementation of this encoder written in
// a different language and runtime, not by the code in this repo. That is the whole
// point of keeping it: a repo can only ever prove itself self-consistent, so a fixture
// from an outside implementation is what turns "our encoder agrees with itself" into
// "two independent encoders agree". The assertions below check both directions — this
// app decodes it, and encodePayload reproduces it byte for byte.
const EXTERNAL_FIXTURE_FRAGMENT =
  'eyJ2IjoxLCJjaGFpbklkIjoiNDY2MyIsInNhZmUiOiIweDM0MzI5MzFjYTlmNThmMzk0M2NFODA2MDM5Yzc5OUYwNjEzODcxQkQiLCJsYWJlbCI6InNhbXBsZSBiYXRjaCIsInR4cyI6W1siMHgyNzAxMjMyYWIxNDJkZkYwMzUyNDVkQmNhQTA4ZTMxNkJmNWQxQjE0IiwiNTAwMDAwMDAwMDAwMDAwIl0sWyIweDBGRWIxN2Y2OTk4MDM4Q0VmQkUxNTI2MGRkMjQ2YTczQWU3NTQ0QWQiLCIxMjUwMDAwMDAwMDAwMDAwIl1dfQ'

const EXTERNAL_FIXTURE_DECODED = {
  v: 1,
  chainId: '4663',
  safe: '0x3432931ca9f58f3943cE806039c799F0613871BD',
  label: "sample batch",
  txs: [
    { to: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', amountWei: '500000000000000' },
    { to: '0x0FEb17f6998038CEfBE15260dd246a73Ae7544Ad', amountWei: '1250000000000000' },
  ],
}

function jsonToFragment(json: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(json))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('decodePayload', () => {
  it('decodes a v1 fragment with no base64 padding', () => {
    const result = decodePayload(SAMPLE_FRAGMENT)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(SAMPLE_DECODED)
  })

  it('decodes a fragment produced by an independent implementation', () => {
    const result = decodePayload(EXTERNAL_FIXTURE_FRAGMENT)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(EXTERNAL_FIXTURE_DECODED)
  })

  it('re-encodes that fixture byte-identically (no cross-implementation drift)', () => {
    const reencoded = encodePayload({
      v: 1,
      chainId: EXTERNAL_FIXTURE_DECODED.chainId,
      safe: EXTERNAL_FIXTURE_DECODED.safe,
      label: EXTERNAL_FIXTURE_DECODED.label,
      txs: EXTERNAL_FIXTURE_DECODED.txs.map((t): [string, string] => [t.to, t.amountWei]),
    })
    expect(reencoded).toBe(EXTERNAL_FIXTURE_FRAGMENT)
  })

  it('decodes the same payload when it carries base64 padding', () => {
    const padded = SAMPLE_FRAGMENT.replace(/-/g, '+').replace(/_/g, '/')
    const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4)
    // This one expects success, so a rewrite that changed nothing would pass without
    // testing anything. Fail loudly instead if the fixture ever stops differing.
    expect(withPadding).not.toBe(SAMPLE_FRAGMENT)
    const result = decodePayload(withPadding)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(SAMPLE_DECODED)
  })

  it('accepts a leading "#" as produced by location.hash', () => {
    const result = decodePayload(`#${SAMPLE_FRAGMENT}`)
    expect(result.ok).toBe(true)
  })

  it('rejects an unsupported version', () => {
    const fragment = jsonToFragment({ ...SAMPLE_DECODED, v: 2, txs: [['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', '1']] })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'UNSUPPORTED_VERSION')).toBe(true)
  })

  it('rejects an empty txs array', () => {
    const fragment = jsonToFragment({ v: 1, chainId: '1', safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', label: '', txs: [] })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'EMPTY_TXS')).toBe(true)
  })

  it.each(['0', '-1', '1.5', '', '1e18', '007'])('rejects amount %j', (amount) => {
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14',
      label: '',
      txs: [['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', amount]],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'INVALID_TX_AMOUNT')).toBe(true)
  })

  it('normalizes an all-lowercase address to its checksum', () => {
    const lower = '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14'.toLowerCase()
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14',
      label: '',
      txs: [[lower, '1']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.txs[0]?.to).toBe('0x2701232ab142dfF035245dBcaA08e316Bf5d1B14')
  })

  it('normalizes an all-uppercase address to its checksum', () => {
    const upper = '0x' + '2701232ab142dfF035245dBcaA08e316Bf5d1B14'.toUpperCase()
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14',
      label: '',
      txs: [[upper, '1']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.txs[0]?.to).toBe('0x2701232ab142dfF035245dBcaA08e316Bf5d1B14')
  })

  it('rejects a mixed-case address that fails EIP-55 checksum', () => {
    const badChecksum = '0x2701232AB142dfF035245dBcaA08e316Bf5d1B14'
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14',
      label: '',
      txs: [[badChecksum, '1']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'INVALID_TX_ADDRESS')).toBe(true)
  })

  it('rejects an address with the wrong length', () => {
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14',
      label: '',
      txs: [['0x9572561eBe198566bBa3B4e7C53F82Ac2758743', '1']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'INVALID_TX_ADDRESS')).toBe(true)
  })

  it('round-trips a Chinese label without mojibake', () => {
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14',
      label: '批次轉帳 🔥',
      txs: [['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', '1']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.label).toBe('批次轉帳 🔥')
  })

  it('rejects a 3-tuple entry with a valid token address (ERC-20 not supported yet)', () => {
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14',
      label: '',
      txs: [['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', '1', '0x6B175474E89094C44Da98b954EedeAC495271d0F']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'UNSUPPORTED_TOKEN' && /ERC-20/.test(e.message))).toBe(true)
  })

  it('rejects a 3-tuple entry with an invalid token address', () => {
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14',
      label: '',
      txs: [['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', '1', 'not-an-address']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'UNSUPPORTED_TOKEN' && /ERC-20/.test(e.message))).toBe(true)
  })

  it('rejects more than MAX_TXS entries', () => {
    const tooMany = Array.from({ length: MAX_TXS + 1 }, () => ['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', '1'])
    const fragment = jsonToFragment({ v: 1, chainId: '1', safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', label: '', txs: tooMany })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'TOO_MANY_TXS')).toBe(true)
  })

  it('accepts exactly MAX_TXS entries', () => {
    const exactly = Array.from({ length: MAX_TXS }, () => ['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', '1'])
    const fragment = jsonToFragment({ v: 1, chainId: '1', safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', label: '', txs: exactly })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
  })

  it('rejects malformed base64', () => {
    const result = decodePayload('not-valid-base64!!!')
    expect(result.ok).toBe(false)
  })

  it('rejects an empty fragment', () => {
    const result = decodePayload('')
    expect(result.ok).toBe(false)
  })
})

describe('encodePayload', () => {
  it('produces a fragment decodePayload can read back', () => {
    const fragment = encodePayload({
      v: 1,
      chainId: '4663',
      safe: '0x3432931ca9f58f3943cE806039c799F0613871BD',
      label: '',
      txs: [['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', '500000000000000']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(SAMPLE_DECODED)
  })

  it('emits base64url without padding, as the wire format requires', () => {
    const fragment = encodePayload({
      v: 1,
      chainId: '4663',
      safe: '0x3432931ca9f58f3943cE806039c799F0613871BD',
      label: '',
      txs: [['0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', '500000000000000']],
    })
    expect(fragment).toBe(SAMPLE_FRAGMENT)
  })
})

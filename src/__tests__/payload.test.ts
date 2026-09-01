import { describe, expect, it } from 'vitest'
import { MAX_TXS, decodePayload, encodePayload } from '../payload.js'

const BEN_FIXTURE_FRAGMENT =
  'eyJ2IjoxLCJjaGFpbklkIjoiNDY2MyIsInNhZmUiOiIweEVlRmE2MjIxMDliNUU5N0I5ODIyMDcyOUZhMzVmQzAzN0I3QjMyMTIiLCJsYWJlbCI6IiIsInR4cyI6W1siMHg5NTcyNTYxZUJlMTk4NTY2YkJhM0I0ZTdDNTNGODJBYzI3NTg3NDMxIiwiNTAwMDAwMDAwMDAwMDAwIl1dfQ'

const BEN_FIXTURE_DECODED = {
  v: 1,
  chainId: '4663',
  safe: '0xEeFa622109b5E97B98220729Fa35fC037B7B3212',
  label: '',
  txs: [{ to: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431', amountWei: '500000000000000' }],
}

// Produced by a MAKE_BATCH_LINK harness running in real Google Sheets on 2026-09-01.
// That harness (apps-script/Code.gs) has since been removed, but this fragment is kept
// deliberately: it is the artifact that closed the "Apps Script encoding is only
// inferred" gap, proving Utilities.base64EncodeWebSafe emits unpadded base64url that
// this app's decoder accepts and that encodePayload reproduces byte-identically. The
// production generator (gas-refill-util's buildBatchLink) uses that same call, so this
// fixture still covers the encoder it depends on.
const GAS_FIXTURE_FRAGMENT =
  'eyJ2IjoxLCJjaGFpbklkIjoiNDY2MyIsInNhZmUiOiIweEVlRmE2MjIxMDliNUU5N0I5ODIyMDcyOUZhMzVmQzAzN0I3QjMyMTIiLCJsYWJlbCI6ImdhcyByZWZpbGwgdGVzdCIsInR4cyI6W1siMHg5NTcyNTYxZUJlMTk4NTY2YkJhM0I0ZTdDNTNGODJBYzI3NTg3NDMxIiwiNTAwMDAwMDAwMDAwMDAwIl0sWyIweDVGOEQ3NGZDRkUwQjQyYTNhNGQ1NjQ2YzBmNWQ5MTI0MDU5ODE3YTIiLCI1MDAwMDAwMDAwMDAwMDAiXV19'

const GAS_FIXTURE_DECODED = {
  v: 1,
  chainId: '4663',
  safe: '0xEeFa622109b5E97B98220729Fa35fC037B7B3212',
  label: 'gas refill test',
  txs: [
    { to: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431', amountWei: '500000000000000' },
    { to: '0x5F8D74fCFE0B42a3a4d5646c0f5d9124059817a2', amountWei: '500000000000000' },
  ],
}

function jsonToFragment(json: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(json))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('decodePayload', () => {
  it("decodes Ben's real fixture (no base64 padding)", () => {
    const result = decodePayload(BEN_FIXTURE_FRAGMENT)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(BEN_FIXTURE_DECODED)
  })

  it('decodes a fragment produced by the real Google Apps Script helper', () => {
    const result = decodePayload(GAS_FIXTURE_FRAGMENT)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(GAS_FIXTURE_DECODED)
  })

  it('re-encodes the Apps Script fixture byte-identically (no cross-runtime drift)', () => {
    const reencoded = encodePayload({
      v: 1,
      chainId: GAS_FIXTURE_DECODED.chainId,
      safe: GAS_FIXTURE_DECODED.safe,
      label: GAS_FIXTURE_DECODED.label,
      txs: GAS_FIXTURE_DECODED.txs.map((t): [string, string] => [t.to, t.amountWei]),
    })
    expect(reencoded).toBe(GAS_FIXTURE_FRAGMENT)
  })

  it('decodes the same payload when it carries base64 padding', () => {
    const padded = BEN_FIXTURE_FRAGMENT.replace(/-/g, '+').replace(/_/g, '/')
    const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4)
    const result = decodePayload(withPadding)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(BEN_FIXTURE_DECODED)
  })

  it('accepts a leading "#" as produced by location.hash', () => {
    const result = decodePayload(`#${BEN_FIXTURE_FRAGMENT}`)
    expect(result.ok).toBe(true)
  })

  it('rejects an unsupported version', () => {
    const fragment = jsonToFragment({ ...BEN_FIXTURE_DECODED, v: 2, txs: [['0x9572561eBe198566bBa3B4e7C53F82Ac27587431', '1']] })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'UNSUPPORTED_VERSION')).toBe(true)
  })

  it('rejects an empty txs array', () => {
    const fragment = jsonToFragment({ v: 1, chainId: '1', safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431', label: '', txs: [] })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'EMPTY_TXS')).toBe(true)
  })

  it.each(['0', '-1', '1.5', '', '1e18', '007'])('rejects amount %j', (amount) => {
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431',
      label: '',
      txs: [['0x9572561eBe198566bBa3B4e7C53F82Ac27587431', amount]],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'INVALID_TX_AMOUNT')).toBe(true)
  })

  it('normalizes an all-lowercase address to its checksum', () => {
    const lower = '0x9572561eBe198566bBa3B4e7C53F82Ac27587431'.toLowerCase()
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431',
      label: '',
      txs: [[lower, '1']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.txs[0]?.to).toBe('0x9572561eBe198566bBa3B4e7C53F82Ac27587431')
  })

  it('normalizes an all-uppercase address to its checksum', () => {
    const upper = '0x' + '9572561eBe198566bBa3B4e7C53F82Ac27587431'.toUpperCase()
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431',
      label: '',
      txs: [[upper, '1']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.txs[0]?.to).toBe('0x9572561eBe198566bBa3B4e7C53F82Ac27587431')
  })

  it('rejects a mixed-case address that fails EIP-55 checksum', () => {
    const badChecksum = '0x9572561EBe198566bBa3B4e7C53F82Ac27587431'
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431',
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
      safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431',
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
      safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431',
      label: '補 gas 給 filler',
      txs: [['0x9572561eBe198566bBa3B4e7C53F82Ac27587431', '1']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.label).toBe('補 gas 給 filler')
  })

  it('rejects a 3-tuple entry with a valid token address (ERC-20 not supported yet)', () => {
    const fragment = jsonToFragment({
      v: 1,
      chainId: '1',
      safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431',
      label: '',
      txs: [['0x9572561eBe198566bBa3B4e7C53F82Ac27587431', '1', '0x6B175474E89094C44Da98b954EedeAC495271d0F']],
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
      safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431',
      label: '',
      txs: [['0x9572561eBe198566bBa3B4e7C53F82Ac27587431', '1', 'not-an-address']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'UNSUPPORTED_TOKEN' && /ERC-20/.test(e.message))).toBe(true)
  })

  it('rejects more than MAX_TXS entries', () => {
    const tooMany = Array.from({ length: MAX_TXS + 1 }, () => ['0x9572561eBe198566bBa3B4e7C53F82Ac27587431', '1'])
    const fragment = jsonToFragment({ v: 1, chainId: '1', safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431', label: '', txs: tooMany })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.errors.some((e) => e.code === 'TOO_MANY_TXS')).toBe(true)
  })

  it('accepts exactly MAX_TXS entries', () => {
    const exactly = Array.from({ length: MAX_TXS }, () => ['0x9572561eBe198566bBa3B4e7C53F82Ac27587431', '1'])
    const fragment = jsonToFragment({ v: 1, chainId: '1', safe: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431', label: '', txs: exactly })
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
      safe: '0xEeFa622109b5E97B98220729Fa35fC037B7B3212',
      label: '',
      txs: [['0x9572561eBe198566bBa3B4e7C53F82Ac27587431', '500000000000000']],
    })
    const result = decodePayload(fragment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toEqual(BEN_FIXTURE_DECODED)
  })

  it('emits base64url without padding, matching the sheet-side format', () => {
    const fragment = encodePayload({
      v: 1,
      chainId: '4663',
      safe: '0xEeFa622109b5E97B98220729Fa35fC037B7B3212',
      label: '',
      txs: [['0x9572561eBe198566bBa3B4e7C53F82Ac27587431', '500000000000000']],
    })
    expect(fragment).toBe(BEN_FIXTURE_FRAGMENT)
  })
})

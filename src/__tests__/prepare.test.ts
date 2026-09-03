import { describe, expect, it } from 'vitest'
import type { BatchPayload } from '../payload.js'
import { prepare } from '../prepare.js'

const BASE_PAYLOAD: BatchPayload = {
  v: 1,
  chainId: '4663',
  safe: '0x3432931ca9f58f3943cE806039c799F0613871BD',
  label: 'test batch',
  txs: [
    { to: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14', amountWei: '500000000000000' },
    { to: '0x0FEb17f6998038CEfBE15260dd246a73Ae7544Ad', amountWei: '1000000000000000' },
  ],
}

const MATCHING_CTX = { chainId: '4663', safe: '0x3432931ca9f58f3943cE806039c799F0613871BD' }

describe('prepare', () => {
  it('produces rows and txs from the same source data', () => {
    const result = prepare(BASE_PAYLOAD, MATCHING_CTX)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    const { rows, txs } = result.value
    expect(rows).toHaveLength(2)
    expect(txs).toHaveLength(2)
    rows.forEach((row, i) => {
      expect(txs[i]?.to).toBe(row.to)
      expect(txs[i]?.value).toBe(row.amountWei)
    })
  })

  it('sets data to "0x" (not empty string) for every tx', () => {
    const result = prepare(BASE_PAYLOAD, MATCHING_CTX)
    if (!result.ok) throw new Error('expected ok')
    for (const tx of result.value.txs) {
      expect(tx.data).toBe('0x')
    }
  })

  it('sums totalWei as a decimal string using bigint arithmetic', () => {
    const result = prepare(BASE_PAYLOAD, MATCHING_CTX)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.totalWei).toBe('1500000000000000')
  })

  it('carries the label through', () => {
    const result = prepare(BASE_PAYLOAD, MATCHING_CTX)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.label).toBe('test batch')
  })

  it('rejects when the Safe context chainId does not match the payload', () => {
    const result = prepare(BASE_PAYLOAD, { chainId: '1', safe: MATCHING_CTX.safe })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected mismatch')
    expect(result.errors.some((e) => e.field === 'chainId')).toBe(true)
  })

  it('rejects when the Safe context address does not match the payload', () => {
    const result = prepare(BASE_PAYLOAD, { chainId: '4663', safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected mismatch')
    expect(result.errors.some((e) => e.field === 'safe')).toBe(true)
  })

  it('matches the safe address case-insensitively', () => {
    const result = prepare(BASE_PAYLOAD, { chainId: '4663', safe: MATCHING_CTX.safe.toLowerCase() })
    expect(result.ok).toBe(true)
  })

  it('can report both chainId and safe mismatches at once', () => {
    const result = prepare(BASE_PAYLOAD, { chainId: '1', safe: '0x2701232ab142dfF035245dBcaA08e316Bf5d1B14' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected mismatch')
    expect(result.errors).toHaveLength(2)
  })
})

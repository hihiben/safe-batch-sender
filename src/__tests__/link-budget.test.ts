import { describe, expect, it } from 'vitest'
import { encodePayload, type WirePayload } from '../payload.js'

const HOST = 'https://hihiben.github.io/safe-batch-sender/'
const SAFE = '0xEeFa622109b5E97B98220729Fa35fC037B7B3212'

function buildDeepLink(shortName: string, chainId: string, txCount: number): string {
  const payload: WirePayload = {
    v: 1,
    chainId,
    safe: SAFE,
    label: 'gas refill batch',
    txs: Array.from({ length: txCount }, (_, i) => [
      // 40 distinct-looking hex chars per row so we don't under-count real-world entropy.
      `0x${(1000000000000000000000000000000000000000n + BigInt(i)).toString(16).padStart(40, '0')}`,
      '500000000000000',
    ]),
  }
  const fragment = encodePayload(payload)
  const appUrl = `${HOST}#${fragment}`
  return `https://app.safe.global/apps/open?safe=${shortName}:${SAFE}&appUrl=${encodeURIComponent(appUrl)}`
}

describe('deep link length budget', () => {
  it('stays well under 8000 chars at the observed max batch size (41 rows, base chain)', () => {
    const link = buildDeepLink('base', '8453', 41)
    expect(link.length).toBeLessThan(8000)
  })

  it('scales roughly linearly and 10 rows is smaller than 41 rows', () => {
    expect(buildDeepLink('base', '8453', 10).length).toBeLessThan(buildDeepLink('base', '8453', 41).length)
  })
})

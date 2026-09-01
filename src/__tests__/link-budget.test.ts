import { describe, expect, it } from 'vitest'
import { MAX_TXS, encodePayload, type WirePayload } from '../payload.js'

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

// app.safe.global is served through CloudFront/S3, which rejects any request
// whose total header section (the request line — i.e. the URL — plus headers)
// exceeds 8192 bytes ("RequestHeaderSectionTooLarge"). Measured empirically
// against the live endpoint (both critic and orchestrator reproduced this
// independently): ~4000 chars -> 200, ~7000 chars -> 400, failure starts
// around 70 rows. Browser cookies eat into the same 8192-byte budget, so the
// real safe margin for a logged-in user is smaller than what curl measures.
// 5000 is comfortably below the observed failure point while covering the
// MAX_TXS=50 cap with room to spare.
const DEEP_LINK_BUDGET_CHARS = 5000

describe('deep link length budget', () => {
  it(`stays under the ${DEEP_LINK_BUDGET_CHARS}-char budget at the observed max batch size (41 rows, base chain)`, () => {
    const link = buildDeepLink('base', '8453', 41)
    expect(link.length).toBeLessThan(DEEP_LINK_BUDGET_CHARS)
  })

  it(`stays under the ${DEEP_LINK_BUDGET_CHARS}-char budget at MAX_TXS (${MAX_TXS} rows, base chain)`, () => {
    const link = buildDeepLink('base', '8453', MAX_TXS)
    expect(link.length).toBeLessThan(DEEP_LINK_BUDGET_CHARS)
  })

  it('scales roughly linearly and 10 rows is smaller than 41 rows', () => {
    expect(buildDeepLink('base', '8453', 10).length).toBeLessThan(buildDeepLink('base', '8453', 41).length)
  })
})

import { describe, expect, it } from 'vitest'
import { MAX_TXS, encodePayload, encodePayloadV2, type BatchInput, type WirePayload } from '../payload.js'

const HOST = 'https://hihiben.github.io/safe-batch-sender/'
const SAFE = '0xEeFa622109b5E97B98220729Fa35fC037B7B3212'

function addressAt(i: number): string {
  // 40 distinct-looking hex chars per row so we don't under-count real-world entropy.
  return `0x${(1000000000000000000000000000000000000000n + BigInt(i)).toString(16).padStart(40, '0')}`
}

function deepLinkFromFragment(shortName: string, fragment: string): string {
  const appUrl = `${HOST}#${fragment}`
  return `https://app.safe.global/apps/open?safe=${shortName}:${SAFE}&appUrl=${encodeURIComponent(appUrl)}`
}

function buildDeepLinkV1(shortName: string, chainId: string, txCount: number): string {
  const payload: WirePayload = {
    v: 1,
    chainId,
    safe: SAFE,
    label: 'test batch',
    txs: Array.from({ length: txCount }, (_, i) => [addressAt(i), '500000000000000']),
  }
  return deepLinkFromFragment(shortName, encodePayload(payload))
}

function buildDeepLinkV2(shortName: string, chainId: string, txCount: number, label: string, amountWei: string): string {
  const input: BatchInput = {
    chainId,
    safe: SAFE,
    label,
    txs: Array.from({ length: txCount }, (_, i) => [addressAt(i), amountWei]),
  }
  return deepLinkFromFragment(shortName, encodePayloadV2(input))
}

// app.safe.global is served through CloudFront/S3, which rejects any request
// whose total header section (the request line — i.e. the URL — plus headers)
// exceeds 8192 bytes ("RequestHeaderSectionTooLarge"). Measured empirically
// against the live endpoint (both critic and orchestrator reproduced this
// independently): ~4000 chars -> 200, ~7000 chars -> 400, failure starts
// around 70 rows. Browser cookies eat into the same 8192-byte budget, so the
// real safe margin for a logged-in user is smaller than what curl measures.
// 5000 is comfortably below the observed failure point while covering the
// MAX_TXS=50 cap with room to spare. This budget only matters while the v1
// encoder still exists (SAFE_BATCH_SENDER_PAYLOAD_V2.md (kept outside this repo, in the operator workspace) §9, rollout
// step 9 removes it).
const V1_DEEP_LINK_BUDGET_CHARS = 5000

// Once v2 packs the payload, CloudFront's 8192-byte ceiling stops being the binding
// constraint: whatever carries the link is now tighter. A typical chat platform we might
// publish through caps a button's URL at 3000 characters, and tools/make-link.mjs
// enforces that as MAX_LINK_CHARS. The literal is repeated here
// on purpose — this test guards an external constraint, so it should fail if the number
// changes, not silently follow it. 2,600 is a regression budget with headroom below it,
// checked separately from the hard limit so a failure names which wall was hit.
const V2_REGRESSION_BUDGET_CHARS = 2600
const CARRIER_LINK_LIMIT_CHARS = 3000
// One generator's policy, not a format rule. A generator that only ever sends amounts
// below 2^80 wei produces links this size; kept as a named example of a realistic upper
// bound, and contrasted below with what the format itself allows.
const GENERATOR_POLICY_MAX_LABEL = 'x'.repeat(64) // MAX_LABEL_BYTES, all-ASCII so 1 byte/char
const GENERATOR_POLICY_MAX_AMOUNT = (1n << 79n).toString() // minimal encoding is exactly 10 bytes
const FORMAT_MAX_AMOUNT = (2n ** 256n - 1n).toString() // MAX_AMOUNT_BYTES = 32

describe('deep link length budget', () => {
  describe('v1', () => {
    it(`stays under the ${V1_DEEP_LINK_BUDGET_CHARS}-char budget at the observed max batch size (41 rows, base chain)`, () => {
      const link = buildDeepLinkV1('base', '8453', 41)
      expect(link.length).toBeLessThan(V1_DEEP_LINK_BUDGET_CHARS)
    })

    it(`stays under the ${V1_DEEP_LINK_BUDGET_CHARS}-char budget at MAX_TXS (${MAX_TXS} rows, base chain)`, () => {
      const link = buildDeepLinkV1('base', '8453', MAX_TXS)
      expect(link.length).toBeLessThan(V1_DEEP_LINK_BUDGET_CHARS)
    })

    it('scales roughly linearly and 10 rows is smaller than 41 rows', () => {
      expect(buildDeepLinkV1('base', '8453', 10).length).toBeLessThan(buildDeepLinkV1('base', '8453', 41).length)
    })
  })

  describe('v2', () => {
    const generatorPolicyMaxLink = () => buildDeepLinkV2('robinhood', '4663', MAX_TXS, GENERATOR_POLICY_MAX_LABEL, GENERATOR_POLICY_MAX_AMOUNT)

    it(`generator policy maximum (robinhood, 64-byte label, ${MAX_TXS} rows, 10-byte amounts) stays under the ${V2_REGRESSION_BUDGET_CHARS}-char regression budget`, () => {
      expect(generatorPolicyMaxLink().length).toBeLessThan(V2_REGRESSION_BUDGET_CHARS)
    })

    it(`generator policy maximum (robinhood, 64-byte label, ${MAX_TXS} rows, 10-byte amounts) stays under the ${CARRIER_LINK_LIMIT_CHARS}-char carrier limit`, () => {
      expect(generatorPolicyMaxLink().length).toBeLessThan(CARRIER_LINK_LIMIT_CHARS)
    })

    it(`format maximum (robinhood, 64-byte label, ${MAX_TXS} rows, 32-byte amounts) exceeds the ${CARRIER_LINK_LIMIT_CHARS}-char carrier limit`, () => {
      const link = buildDeepLinkV2('robinhood', '4663', MAX_TXS, GENERATOR_POLICY_MAX_LABEL, FORMAT_MAX_AMOUNT)
      expect(link.length).toBeGreaterThan(CARRIER_LINK_LIMIT_CHARS)
    })
  })
})

import { describe, expect, it } from 'vitest'
import { CHAINS, getChainInfo } from '../chains.js'

// Expected values pinned from https://safe-config.safe.global/api/v1/chains/ (no network
// calls in CI — see planner's note on Arbitrum=AETH / Gnosis=XDAI, which differ from the
// tokens' own tickers).
const EXPECTED = {
  '1': { shortName: 'eth', nativeSymbol: 'ETH', nativeDecimals: 18 },
  '100': { shortName: 'gno', nativeSymbol: 'XDAI', nativeDecimals: 18 },
  '42161': { shortName: 'arb1', nativeSymbol: 'AETH', nativeDecimals: 18 },
  '8453': { shortName: 'base', nativeSymbol: 'ETH', nativeDecimals: 18 },
  '56': { shortName: 'bnb', nativeSymbol: 'BNB', nativeDecimals: 18 },
  '4663': { shortName: 'robinhood', nativeSymbol: 'ETH', nativeDecimals: 18 },
} as const

describe('CHAINS', () => {
  it('covers exactly the six required chains', () => {
    expect(Object.keys(CHAINS).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  for (const [chainId, expected] of Object.entries(EXPECTED)) {
    it(`matches Safe config API for chainId ${chainId}`, () => {
      expect(getChainInfo(chainId)).toEqual({ chainId, ...expected })
    })
  }

  it('returns undefined for an unknown chainId', () => {
    expect(getChainInfo('999999')).toBeUndefined()
  })
})

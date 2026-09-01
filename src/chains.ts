/**
 * Static fallback table for the six supported chains, pinned from
 * https://safe-config.safe.global/api/v1/chains/ on 2026-09-01.
 *
 * This is ONLY for the non-iframe read-only preview. Inside the Safe iframe,
 * `sdk.safe.getChainInfo().nativeCurrency` is the source of truth — the running
 * Safe instance always wins over a table baked in at build time.
 */
export interface ChainInfo {
  chainId: string
  shortName: string
  nativeSymbol: string
  nativeDecimals: number
}

export const CHAINS: Record<string, ChainInfo> = {
  '1': { chainId: '1', shortName: 'eth', nativeSymbol: 'ETH', nativeDecimals: 18 },
  '100': { chainId: '100', shortName: 'gno', nativeSymbol: 'XDAI', nativeDecimals: 18 },
  '42161': { chainId: '42161', shortName: 'arb1', nativeSymbol: 'AETH', nativeDecimals: 18 },
  '8453': { chainId: '8453', shortName: 'base', nativeSymbol: 'ETH', nativeDecimals: 18 },
  '56': { chainId: '56', shortName: 'bnb', nativeSymbol: 'BNB', nativeDecimals: 18 },
  '4663': { chainId: '4663', shortName: 'robinhood', nativeSymbol: 'ETH', nativeDecimals: 18 },
}

export function getChainInfo(chainId: string): ChainInfo | undefined {
  return CHAINS[chainId]
}

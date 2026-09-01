import SafeAppsSDK from '@safe-global/safe-apps-sdk'
import type { PreparedTx } from './prepare.js'

export interface SafeContext {
  chainId: string
  safe: string
  nativeSymbol: string
  nativeDecimals: number
}

/**
 * Outside an iframe, the SDK's postMessage calls have no one to answer them and
 * the returned promise never settles — there is no error to catch. Callers must
 * check this before making any SDK call.
 */
export function isInIframe(): boolean {
  try {
    return window.self !== window.top
  } catch {
    // Cross-origin access to window.top throws in some browsers; being unable to
    // reach it at all is itself evidence of running inside a frame.
    return true
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

export function createSdk(): SafeAppsSDK {
  return new SafeAppsSDK()
}

export async function getSafeContext(sdk: SafeAppsSDK): Promise<SafeContext> {
  const [info, chainInfo] = await Promise.all([
    withTimeout(sdk.safe.getInfo(), 3000, 'Timed out waiting for the Safe to report its context (getInfo).'),
    withTimeout(sdk.safe.getChainInfo(), 3000, 'Timed out waiting for the Safe to report chain info (getChainInfo).'),
  ])
  return {
    // info.chainId is a number; chainInfo.chainId is a string. The payload's chainId
    // is a string, so normalize through String() rather than trusting either shape.
    chainId: String(info.chainId),
    safe: info.safeAddress,
    nativeSymbol: chainInfo.nativeCurrency.symbol,
    nativeDecimals: chainInfo.nativeCurrency.decimals,
  }
}

export async function proposeBatch(sdk: SafeAppsSDK, txs: PreparedTx[]): Promise<string> {
  const { safeTxHash } = await sdk.txs.send({ txs })
  return safeTxHash
}

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

/**
 * Without this, any page can iframe this app on its real
 * origin and answer its postMessage calls itself, rendering a fully-formed
 * "Propose to Safe" preview with attacker-chosen amounts/symbols (the SDK
 * default is no origin restriction at all). The attacker still can't get a
 * signature out of it — Safe itself never validated this origin either — but
 * locking it removes a phishing surface for free.
 *
 * The option is `allowedDomains` (not `allowedOrigins`, which is the SDK's own
 * private internal field name for the same thing — confirmed against
 * node_modules/@safe-global/safe-apps-sdk's Opts type).
 */
export function createSdk(): SafeAppsSDK {
  return new SafeAppsSDK({ allowedDomains: [/^https:\/\/app\.safe\.global$/] })
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

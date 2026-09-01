import type SafeAppsSDK from '@safe-global/safe-apps-sdk'
import { getChainInfo } from './chains.js'
import { decodePayload } from './payload.js'
import { prepare, type PreparedTx } from './prepare.js'
import { renderErrors, renderLoading, renderNoPayload, renderPreview, renderProposeError, renderProposeSuccess, type PreviewHandle } from './render.js'
import { createSdk, getSafeContext, isInIframe, proposeBatch } from './safe.js'

function requireApp(): HTMLElement {
  const app = document.getElementById('app')
  if (!app) throw new Error('missing #app root element')
  return app
}

export async function handlePropose(sdk: SafeAppsSDK, txs: PreparedTx[], handle: PreviewHandle): Promise<void> {
  const { button, statusEl } = handle
  button.disabled = true
  button.textContent = 'Waiting for signature…'
  try {
    const safeTxHash = await proposeBatch(sdk, txs)
    button.disabled = true
    button.textContent = 'Proposed'
    renderProposeSuccess(statusEl, safeTxHash)
  } catch (err) {
    // Only statusEl is touched here — the preview table and the button itself
    // stay exactly as they were, so a rejected signature is retryable without
    // a page reload (see render.ts's PreviewHandle doc comment for why).
    button.disabled = false
    button.textContent = 'Propose to Safe'
    renderProposeError(statusEl, err instanceof Error ? err.message : String(err))
  }
}

export async function run(): Promise<void> {
  const root = requireApp()
  const fragment = window.location.hash
  if (!fragment) {
    renderNoPayload(root)
    return
  }

  const decoded = decodePayload(fragment)
  if (!decoded.ok) {
    renderErrors(
      root,
      'This link is malformed.',
      decoded.errors.map((e) => e.message),
    )
    return
  }
  const payload = decoded.value

  if (!isInIframe()) {
    // No live Safe to compare against outside the iframe — the payload's own
    // chainId/safe stand in as the "context" purely to drive the read-only preview.
    const chainInfo = getChainInfo(payload.chainId)
    const prepared = prepare(payload, { chainId: payload.chainId, safe: payload.safe })
    if (!prepared.ok) return // unreachable: ctx mirrors the payload's own fields
    renderPreview(root, {
      label: prepared.value.label,
      rows: prepared.value.rows,
      totalWei: prepared.value.totalWei,
      nativeSymbol: chainInfo?.nativeSymbol ?? 'ETH',
      nativeDecimals: chainInfo?.nativeDecimals ?? 18,
      readOnly: true,
    })
    return
  }

  renderLoading(root)
  const sdk = createSdk()

  let ctx: Awaited<ReturnType<typeof getSafeContext>>
  try {
    ctx = await getSafeContext(sdk)
  } catch (err) {
    renderErrors(root, 'Could not reach the Safe.', [err instanceof Error ? err.message : String(err)])
    return
  }

  const prepared = prepare(payload, { chainId: ctx.chainId, safe: ctx.safe })
  if (!prepared.ok) {
    renderErrors(
      root,
      'This link does not match the Safe you have open.',
      prepared.errors.map((e) => `${e.field}: link says ${e.actual}, this Safe is ${e.expected}`),
    )
    return
  }

  const handle = renderPreview(root, {
    label: prepared.value.label,
    rows: prepared.value.rows,
    totalWei: prepared.value.totalWei,
    nativeSymbol: ctx.nativeSymbol,
    nativeDecimals: ctx.nativeDecimals,
    readOnly: false,
    onPropose: () => {
      if (handle) void handlePropose(sdk, prepared.value.txs, handle)
    },
  })
}

// Guarded so importing this module in a test doesn't also run the app against
// whatever the test's DOM/location happen to look like. Vitest sets MODE to
// 'test' by default; Vite's production build never does.
if (import.meta.env.MODE !== 'test') {
  run().catch((err) => {
    renderErrors(requireApp(), 'Unexpected error.', [err instanceof Error ? err.message : String(err)])
  })
}

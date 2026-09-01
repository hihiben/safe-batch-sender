// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeMocks = vi.hoisted(() => ({
  isInIframe: vi.fn(),
  createSdk: vi.fn(),
  getSafeContext: vi.fn(),
  proposeBatch: vi.fn(),
}))

vi.mock('../safe.js', () => safeMocks)

import { renderPreview } from '../render.js'
import { handlePropose, run } from '../main.js'

// Ben's real fixture, robinhood chain, 1 tx of 0.0005 ETH.
const VALID_FRAGMENT =
  'eyJ2IjoxLCJjaGFpbklkIjoiNDY2MyIsInNhZmUiOiIweEVlRmE2MjIxMDliNUU5N0I5ODIyMDcyOUZhMzVmQzAzN0I3QjMyMTIiLCJsYWJlbCI6IiIsInR4cyI6W1siMHg5NTcyNTYxZUJlMTk4NTY2YkJhM0I0ZTdDNTNGODJBYzI3NTg3NDMxIiwiNTAwMDAwMDAwMDAwMDAwIl1dfQ'

function setHash(hash: string): void {
  window.location.hash = hash
}

function app(): HTMLElement {
  const el = document.getElementById('app')
  if (!el) throw new Error('test setup missing #app')
  return el
}

beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>'
  safeMocks.isInIframe.mockReset()
  safeMocks.createSdk.mockReset().mockReturnValue({})
  safeMocks.getSafeContext.mockReset()
  safeMocks.proposeBatch.mockReset()
  window.location.hash = ''
})

describe('run()', () => {
  it('shows the no-payload message when there is no fragment', async () => {
    setHash('')
    await run()
    expect(app().textContent).toContain('no batch payload was found')
  })

  it('shows a malformed-link error for a bad fragment', async () => {
    setHash('#not-valid-base64!!!')
    await run()
    expect(app().textContent).toContain('malformed')
  })

  it('renders a read-only preview with no button outside an iframe', async () => {
    safeMocks.isInIframe.mockReturnValue(false)
    setHash(`#${VALID_FRAGMENT}`)
    await run()
    expect(app().querySelector('button')).toBeNull()
    expect(app().textContent).toContain('Read-only preview')
    expect(app().textContent).toContain('0.0005 ETH')
  })

  it('shows a mismatch error (and no button) when the Safe context does not match the payload', async () => {
    safeMocks.isInIframe.mockReturnValue(true)
    safeMocks.getSafeContext.mockResolvedValue({
      chainId: '1',
      safe: '0x0000000000000000000000000000000000000001',
      nativeSymbol: 'ETH',
      nativeDecimals: 18,
    })
    setHash(`#${VALID_FRAGMENT}`)
    await run()
    expect(app().querySelector('button')).toBeNull()
    expect(app().textContent).toContain('does not match the Safe you have open')
  })

  it('renders an interactive preview with a Propose button when the context matches', async () => {
    safeMocks.isInIframe.mockReturnValue(true)
    safeMocks.getSafeContext.mockResolvedValue({
      chainId: '4663',
      safe: '0xEeFa622109b5E97B98220729Fa35fC037B7B3212',
      nativeSymbol: 'ETH',
      nativeDecimals: 18,
    })
    setHash(`#${VALID_FRAGMENT}`)
    await run()
    expect(app().querySelector('button')).not.toBeNull()
    expect(app().textContent).toContain('0.0005 ETH')
  })

  it('matches the safe address case-insensitively (lowercase Safe context)', async () => {
    safeMocks.isInIframe.mockReturnValue(true)
    safeMocks.getSafeContext.mockResolvedValue({
      chainId: '4663',
      safe: '0xEeFa622109b5E97B98220729Fa35fC037B7B3212'.toLowerCase(),
      nativeSymbol: 'ETH',
      nativeDecimals: 18,
    })
    setHash(`#${VALID_FRAGMENT}`)
    await run()
    expect(app().querySelector('button')).not.toBeNull()
  })

  it('shows an error, not a stuck loading state, if getSafeContext throws', async () => {
    safeMocks.isInIframe.mockReturnValue(true)
    safeMocks.getSafeContext.mockRejectedValue(new Error('Timed out waiting for the Safe to report its context (getInfo).'))
    setHash(`#${VALID_FRAGMENT}`)
    await run()
    expect(app().textContent).toContain('Could not reach the Safe')
    expect(app().textContent).not.toContain('Loading')
  })
})

describe('handlePropose (S5: retry after a rejected/failed propose)', () => {
  it('a failed propose leaves the preview and button retryable, and a retry can succeed', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const row = { to: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431', amountWei: '1' }
    const handle = renderPreview(container, {
      label: '',
      rows: [row],
      totalWei: '1',
      nativeSymbol: 'ETH',
      nativeDecimals: 18,
      readOnly: false,
    })
    if (!handle) throw new Error('expected a handle in non-read-only mode')
    const txs = [{ to: row.to, value: row.amountWei, data: '0x' as const }]

    safeMocks.proposeBatch.mockRejectedValueOnce(new Error('User rejected the request'))
    await handlePropose({} as never, txs, handle)

    expect(handle.button.disabled).toBe(false)
    expect(handle.button.textContent).toBe('Propose to Safe')
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(handle.statusEl.textContent).toContain('User rejected the request')

    safeMocks.proposeBatch.mockResolvedValueOnce('0xsafeTxHash123')
    await handlePropose({} as never, txs, handle)

    expect(handle.button.disabled).toBe(true)
    expect(handle.button.textContent).toBe('Proposed')
    expect(handle.statusEl.textContent).toContain('0xsafeTxHash123')
  })

  it('disables the button and shows a waiting label while the propose is in flight', async () => {
    const container = document.createElement('div')
    const row = { to: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431', amountWei: '1' }
    const handle = renderPreview(container, {
      label: '',
      rows: [row],
      totalWei: '1',
      nativeSymbol: 'ETH',
      nativeDecimals: 18,
      readOnly: false,
    })
    if (!handle) throw new Error('expected a handle in non-read-only mode')

    let resolveSend!: (hash: string) => void
    safeMocks.proposeBatch.mockReturnValueOnce(new Promise<string>((resolve) => (resolveSend = resolve)))

    const pending = handlePropose({} as never, [{ to: row.to, value: row.amountWei, data: '0x' as const }], handle)
    expect(handle.button.disabled).toBe(true)
    expect(handle.button.textContent).toBe('Waiting for signature…')

    resolveSend('0xhash')
    await pending
  })
})

// @vitest-environment happy-dom
import { parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'
import type { PreparedRow } from '../prepare.js'
import { renderErrors, renderLoading, renderNoPayload, renderPreview, renderProposeError, renderProposeSuccess } from '../render.js'

const ROWS: PreparedRow[] = [
  { to: '0x9572561eBe198566bBa3B4e7C53F82Ac27587431', amountWei: '500000000000000' },
  { to: '0x8d10551fbB0dA1eaDF34B25210fE75F278fa9321', amountWei: '1000000000000000' },
]

function baseOpts(overrides: Partial<Parameters<typeof renderPreview>[1]> = {}) {
  return {
    label: 'gas refill',
    rows: ROWS,
    totalWei: '1500000000000000',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    readOnly: false,
    ...overrides,
  }
}

describe('renderPreview', () => {
  it('renders one table cell per PreparedRow field, and every value round-trips (S1 regression canary)', () => {
    const container = document.createElement('div')
    renderPreview(container, baseOpts({ readOnly: true }))

    const dataRows = container.querySelectorAll('tbody tr')
    expect(dataRows).toHaveLength(ROWS.length)

    dataRows.forEach((tr, i) => {
      const row = ROWS[i]!
      const cells = tr.querySelectorAll('td')
      // If PreparedRow ever grows a field, this trips until render.ts is
      // updated to display it too — this is exactly the shape of bug S1 was:
      // a field that existed on the data but never reached the DOM.
      expect(cells.length).toBe(Object.keys(row).length)
      expect(cells[0]?.textContent).toBe(row.to)
      const [amountPart, symbolPart] = (cells[1]?.textContent ?? '').split(' ')
      expect(symbolPart).toBe('ETH')
      expect(parseUnits(amountPart ?? '0', 18).toString()).toBe(row.amountWei)
    })
  })

  it('shows full, untruncated addresses', () => {
    const container = document.createElement('div')
    renderPreview(container, baseOpts({ readOnly: true }))
    for (const row of ROWS) {
      expect(container.textContent).toContain(row.to)
    }
  })

  it('shows the correct total', () => {
    const container = document.createElement('div')
    renderPreview(container, baseOpts({ readOnly: true }))
    expect(container.textContent).toContain('0.0015 ETH')
  })

  it('shows the label as a heading, and omits it when empty', () => {
    const withLabel = document.createElement('div')
    renderPreview(withLabel, baseOpts({ readOnly: true, label: 'gas refill' }))
    expect(withLabel.querySelector('h2')?.textContent).toBe('gas refill')

    const withoutLabel = document.createElement('div')
    renderPreview(withoutLabel, baseOpts({ readOnly: true, label: '' }))
    expect(withoutLabel.querySelector('h2')).toBeNull()
  })

  it('read-only mode renders no button and returns null', () => {
    const container = document.createElement('div')
    const handle = renderPreview(container, baseOpts({ readOnly: true }))
    expect(handle).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })

  it('read-only mode shows the read-only notice', () => {
    const container = document.createElement('div')
    renderPreview(container, baseOpts({ readOnly: true }))
    expect(container.textContent).toContain('Read-only preview')
  })

  it('non-read-only mode returns a button and a status slot', () => {
    const container = document.createElement('div')
    const handle = renderPreview(container, baseOpts({ readOnly: false }))
    expect(handle?.button).toBeInstanceOf(HTMLButtonElement)
    expect(handle?.statusEl).toBeInstanceOf(HTMLElement)
    expect(container.contains(handle!.button)).toBe(true)
    expect(container.contains(handle!.statusEl)).toBe(true)
  })

  it('wires the button click to onPropose', () => {
    const container = document.createElement('div')
    let clicked = 0
    const handle = renderPreview(container, baseOpts({ readOnly: false, onPropose: () => clicked++ }))
    handle?.button.click()
    expect(clicked).toBe(1)
  })
})

describe('renderProposeError / renderProposeSuccess (S5)', () => {
  it('renderProposeError only touches statusEl — the preview table and button survive', () => {
    const container = document.createElement('div')
    const handle = renderPreview(container, baseOpts({ readOnly: false }))!

    renderProposeError(handle.statusEl, 'User rejected the request')

    expect(container.querySelector('table')).not.toBeNull()
    expect(container.contains(handle.button)).toBe(true)
    expect(handle.statusEl.textContent).toContain('User rejected the request')
    // Rows are still there too, not just the table shell.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(ROWS.length)
  })

  it('renderProposeSuccess only touches statusEl — the preview stays visible', () => {
    const container = document.createElement('div')
    const handle = renderPreview(container, baseOpts({ readOnly: false }))!

    renderProposeSuccess(handle.statusEl, '0xdeadbeef')

    expect(container.querySelector('table')).not.toBeNull()
    expect(handle.statusEl.textContent).toContain('0xdeadbeef')
  })

  it('a second renderProposeError call replaces the first instead of appending', () => {
    const container = document.createElement('div')
    const handle = renderPreview(container, baseOpts({ readOnly: false }))!
    renderProposeError(handle.statusEl, 'first failure')
    renderProposeError(handle.statusEl, 'second failure')
    expect(handle.statusEl.textContent).toContain('second failure')
    expect(handle.statusEl.textContent).not.toContain('first failure')
  })
})

describe('renderErrors', () => {
  it('shows the title and every message', () => {
    const container = document.createElement('div')
    renderErrors(container, 'This link is malformed.', ['bad thing one', 'bad thing two'])
    expect(container.textContent).toContain('This link is malformed.')
    expect(container.textContent).toContain('bad thing one')
    expect(container.textContent).toContain('bad thing two')
  })

  it('clears whatever was in the container before', () => {
    const container = document.createElement('div')
    container.textContent = 'stale content'
    renderErrors(container, 'title', ['msg'])
    expect(container.textContent).not.toContain('stale content')
  })
})

describe('renderLoading / renderNoPayload', () => {
  it('renderLoading shows a loading message', () => {
    const container = document.createElement('div')
    renderLoading(container)
    expect(container.textContent).toContain('Loading')
  })

  it('renderNoPayload shows a no-payload message', () => {
    const container = document.createElement('div')
    renderNoPayload(container)
    expect(container.textContent).toContain('no batch payload was found')
  })
})

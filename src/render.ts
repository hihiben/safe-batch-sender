import { formatUnits } from 'viem'
import type { PreparedRow } from './prepare.js'

export interface PreviewOptions {
  label: string
  rows: PreparedRow[]
  totalWei: string
  nativeSymbol: string
  nativeDecimals: number
  readOnly: boolean
  onPropose?: () => void
}

/**
 * `button` toggles disabled/text while a propose is in flight; `statusEl` is
 * where the outcome (error or success) gets written. Errors write into
 * `statusEl` only — never into `container` — so a failed/rejected propose
 * leaves the preview and the button in place and retryable, instead of
 * wiping the whole screen and forcing a reload.
 */
export interface PreviewHandle {
  button: HTMLButtonElement
  statusEl: HTMLElement
}

function clear(container: HTMLElement): void {
  while (container.firstChild) container.removeChild(container.firstChild)
}

function formatAmount(amountWei: string, decimals: number, symbol: string): string {
  return `${formatUnits(BigInt(amountWei), decimals)} ${symbol}`
}

export function renderLoading(container: HTMLElement): void {
  clear(container)
  const p = document.createElement('p')
  p.textContent = 'Loading Safe context…'
  container.appendChild(p)
}

export function renderErrors(container: HTMLElement, title: string, messages: string[]): void {
  clear(container)
  const heading = document.createElement('p')
  heading.className = 'error-title'
  heading.textContent = title
  container.appendChild(heading)
  const list = document.createElement('ul')
  list.className = 'error-list'
  for (const message of messages) {
    const item = document.createElement('li')
    item.textContent = message
    list.appendChild(item)
  }
  container.appendChild(list)
}

export function renderNoPayload(container: HTMLElement): void {
  clear(container)
  const p = document.createElement('p')
  p.textContent = 'Open this app via a Safe batch-send link — no batch payload was found in the URL.'
  container.appendChild(p)
}

/** Returns a handle to the button + status slot, or null in read-only mode (no button at all). */
export function renderPreview(container: HTMLElement, opts: PreviewOptions): PreviewHandle | null {
  clear(container)

  if (opts.readOnly) {
    const notice = document.createElement('p')
    notice.className = 'notice'
    notice.textContent = 'Read-only preview — open this link inside Safe{Wallet} to propose the transaction.'
    container.appendChild(notice)
  }

  if (opts.label) {
    const heading = document.createElement('h2')
    heading.textContent = opts.label
    container.appendChild(heading)
  }

  const table = document.createElement('table')
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const text of ['Recipient', 'Amount']) {
    const th = document.createElement('th')
    th.textContent = text
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const row of opts.rows) {
    const tr = document.createElement('tr')
    const tdTo = document.createElement('td')
    tdTo.textContent = row.to
    tdTo.className = 'address'
    const tdAmount = document.createElement('td')
    tdAmount.textContent = formatAmount(row.amountWei, opts.nativeDecimals, opts.nativeSymbol)
    tr.append(tdTo, tdAmount)
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  container.appendChild(table)

  const summary = document.createElement('p')
  summary.className = 'summary'
  summary.textContent = `${opts.rows.length} recipients — total ${formatAmount(opts.totalWei, opts.nativeDecimals, opts.nativeSymbol)}`
  container.appendChild(summary)

  if (opts.readOnly) return null

  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Propose to Safe'
  if (opts.onPropose) button.addEventListener('click', opts.onPropose)
  container.appendChild(button)

  const statusEl = document.createElement('div')
  statusEl.className = 'propose-status'
  container.appendChild(statusEl)

  return { button, statusEl }
}

export function renderProposeError(statusEl: HTMLElement, message: string): void {
  clear(statusEl)
  const p = document.createElement('p')
  p.className = 'error-title'
  p.textContent = message
  statusEl.appendChild(p)
}

export function renderProposeSuccess(statusEl: HTMLElement, safeTxHash: string): void {
  clear(statusEl)
  const p = document.createElement('p')
  p.className = 'success'
  p.textContent = `Proposed. safeTxHash: ${safeTxHash}`
  statusEl.appendChild(p)
}

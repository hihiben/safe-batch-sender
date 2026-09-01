import type { BatchPayload } from './payload.js'
import type { Result } from './payload.js'

export interface SafeContext {
  chainId: string
  safe: string
}

export interface PreparedRow {
  to: string
  amountWei: string
}

export interface PreparedTx {
  to: string
  value: string
  data: '0x'
}

export interface PreparedBatch {
  rows: PreparedRow[]
  txs: PreparedTx[]
  totalWei: string
  label: string
}

export interface Mismatch {
  field: 'chainId' | 'safe'
  expected: string
  actual: string
}

/**
 * txs (what gets sent to the Safe) is derived FROM rows (what the owner reviews),
 * not computed separately from payload.txs — so there is exactly one array that
 * decides what the preview shows, and it's the same array that decides what gets
 * signed. There is no code path where they could diverge.
 */
export function prepare(payload: BatchPayload, ctx: SafeContext): Result<PreparedBatch, Mismatch> {
  const mismatches: Mismatch[] = []
  if (payload.chainId !== ctx.chainId) {
    mismatches.push({ field: 'chainId', expected: ctx.chainId, actual: payload.chainId })
  }
  if (payload.safe.toLowerCase() !== ctx.safe.toLowerCase()) {
    mismatches.push({ field: 'safe', expected: ctx.safe, actual: payload.safe })
  }
  if (mismatches.length > 0) return { ok: false, errors: mismatches }

  const rows: PreparedRow[] = payload.txs.map((tx) => ({ to: tx.to, amountWei: tx.amountWei }))
  const txs: PreparedTx[] = rows.map((row) => ({ to: row.to, value: row.amountWei, data: '0x' }))
  const totalWei = rows.reduce((sum, row) => sum + BigInt(row.amountWei), 0n).toString()

  return { ok: true, value: { rows, txs, totalWei, label: payload.label } }
}

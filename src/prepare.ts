import type { BatchPayload } from './payload.js'
import type { Result } from './payload.js'

export interface SafeContext {
  chainId: string
  safe: string
}

export interface PreparedRow {
  to: string
  amountWei: string
  tokenAddress?: string
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
 * Rows (what the owner reviews) and txs (what gets sent to the Safe) are derived
 * from the same payload.txs array in one pass, so "what you see" and "what you sign"
 * can never drift apart.
 */
export function prepare(payload: BatchPayload, ctx: SafeContext): Result<PreparedBatch, Mismatch[]> {
  const mismatches: Mismatch[] = []
  if (payload.chainId !== ctx.chainId) {
    mismatches.push({ field: 'chainId', expected: ctx.chainId, actual: payload.chainId })
  }
  if (payload.safe.toLowerCase() !== ctx.safe.toLowerCase()) {
    mismatches.push({ field: 'safe', expected: ctx.safe, actual: payload.safe })
  }
  if (mismatches.length > 0) return { ok: false, errors: mismatches }

  const rows: PreparedRow[] = []
  const txs: PreparedTx[] = []
  let totalWei = 0n

  for (const tx of payload.txs) {
    rows.push(tx.tokenAddress ? { to: tx.to, amountWei: tx.amountWei, tokenAddress: tx.tokenAddress } : { to: tx.to, amountWei: tx.amountWei })
    txs.push({ to: tx.to, value: tx.amountWei, data: '0x' })
    totalWei += BigInt(tx.amountWei)
  }

  return { ok: true, value: { rows, txs, totalWei: totalWei.toString(), label: payload.label } }
}

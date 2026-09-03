#!/usr/bin/env node
// Builds a Safe batch-send deep link from a JSON file of [to, amountWei] rows.
// Reuses the same encoder the app decodes with — no second implementation of the
// wire format to drift out of sync.
//
// Usage:
//   node tools/make-link.mjs --chain <chain> --safe <0xSafe> --label "..." rows.json
//   node tools/make-link.mjs --chain <chain> --safe <0xSafe> --format v2 --label "..." rows.json
//
// rows.json: [["0xRecipient...", "500000000000000"], ...]

import { readFileSync } from 'node:fs'
import { encodePayload, encodePayloadV2, normalizeAddress } from '../src/payload.ts'
import { CHAINS } from '../src/chains.ts'

const APP_HOST = 'https://dinngo.github.io/safe-batch-sender/'

// A link is only useful if whatever carries it will accept the whole string. Chat
// platforms commonly cap a button's URL at 3000 characters, which is tighter than
// anything the wire format imposes, so that is the default here. It is a property of
// wherever you publish links, not of the format, which is why it lives in this tool
// rather than in src/payload.ts — change it to match your own carrier.
const MAX_LINK_CHARS = 3000

function parseArgs(argv) {
  const args = { chain: undefined, safe: undefined, label: '', file: undefined, format: 'v1' }
  // A flag's value is never another flag. Without this, `--safe --format v2` silently
  // reads "--format" as the Safe address AND drops the format, so you ask for v2 and
  // get v1 pointed at a nonsense address, with no error anywhere.
  const value = (i, flag) => {
    const next = argv[i]
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
    return next
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--chain') args.chain = value(++i, '--chain')
    else if (arg === '--safe') args.safe = value(++i, '--safe')
    else if (arg === '--label') args.label = value(++i, '--label')
    else if (arg === '--format') args.format = value(++i, '--format')
    else if (!arg.startsWith('--')) args.file = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!args.chain) throw new Error('--chain is required (chainId or shortName, e.g. "robinhood" or "4663")')
  if (!args.safe) throw new Error('--safe is required (the Safe address the batch will be proposed to)')
  // Check it here, for both formats. encodePayloadV2 rejects a bad address on its own,
  // but the v1 encoder just JSON.stringifies whatever it is given — so without this the
  // default format happily prints a link built around a placeholder like "0xYourSafe...",
  // and the mistake only surfaces in the app. normalizeAddress is the format's own rule,
  // reused rather than reimplemented. The raw value is still what gets encoded, so a
  // valid input produces exactly the bytes it did before.
  if (!normalizeAddress(args.safe)) throw new Error(`--safe is not a valid address: ${JSON.stringify(args.safe)}`)
  if (!args.file) throw new Error('Path to a rows JSON file is required')
  if (args.format !== 'v1' && args.format !== 'v2') throw new Error(`--format must be "v1" or "v2", got "${args.format}"`)
  return args
}

function resolveChain(chainArg) {
  const byId = CHAINS[chainArg]
  if (byId) return byId
  const byShortName = Object.values(CHAINS).find((c) => c.shortName === chainArg)
  if (byShortName) return byShortName
  throw new Error(`Unknown chain "${chainArg}". Known: ${Object.values(CHAINS).map((c) => `${c.shortName} (${c.chainId})`).join(', ')}`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const chain = resolveChain(args.chain)
  const rows = JSON.parse(readFileSync(args.file, 'utf8'))
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${args.file} must contain a non-empty JSON array of [to, amountWei] rows`)
  }

  const fragment =
    args.format === 'v2'
      ? encodePayloadV2({ chainId: chain.chainId, safe: args.safe, label: args.label, txs: rows })
      : encodePayload({ v: 1, chainId: chain.chainId, safe: args.safe, label: args.label, txs: rows })

  const appUrl = `${APP_HOST}#${fragment}`
  const link = `https://app.safe.global/apps/open?safe=${chain.shortName}:${args.safe}&appUrl=${encodeURIComponent(appUrl)}`
  if (link.length > MAX_LINK_CHARS) {
    throw new Error(`Link is ${link.length} characters, which exceeds the ${MAX_LINK_CHARS}-char limit of the carrier this tool targets`)
  }
  console.log(link)
}

main()

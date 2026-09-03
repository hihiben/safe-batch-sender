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
import { encodePayload, encodePayloadV2 } from '../src/payload.ts'
import { CHAINS } from '../src/chains.ts'

const APP_HOST = 'https://hihiben.github.io/safe-batch-sender/'

// A link is only useful if whatever carries it will accept the whole string, and the
// tightest carrier we post links through is a Slack Block Kit button, whose `url` field
// is capped at 3000 characters. That is a property of the consumer, not of the wire
// format, so it lives here rather than in src/payload.ts — point this at your own
// carrier's limit if you publish links some other way.
const MAX_LINK_CHARS = 3000

function parseArgs(argv) {
  const args = { chain: undefined, safe: undefined, label: '', file: undefined, format: 'v1' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--chain') args.chain = argv[++i]
    else if (arg === '--safe') args.safe = argv[++i]
    else if (arg === '--label') args.label = argv[++i]
    else if (arg === '--format') args.format = argv[++i]
    else if (!arg.startsWith('--')) args.file = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!args.chain) throw new Error('--chain is required (chainId or shortName, e.g. "robinhood" or "4663")')
  if (!args.safe) throw new Error('--safe is required (the Safe address the batch will be proposed to)')
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

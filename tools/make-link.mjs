#!/usr/bin/env node
// Builds a Safe batch-send deep link from a JSON file of [to, amountWei] rows.
// Reuses the same encoder the app decodes with — no second implementation of the
// wire format to drift out of sync.
//
// Usage:
//   node tools/make-link.mjs --chain robinhood --label "gas refill" rows.json
//   node tools/make-link.mjs --chain robinhood --format v2 --label "gas refill" rows.json
//
// rows.json: [["0xRecipient...", "500000000000000"], ...]

import { readFileSync } from 'node:fs'
import { SLACK_BUTTON_URL_LIMIT, encodePayload, encodePayloadV2 } from '../src/payload.ts'
import { CHAINS } from '../src/chains.ts'

const APP_HOST = 'https://hihiben.github.io/safe-batch-sender/'
const DEFAULT_SAFE = '0xEeFa622109b5E97B98220729Fa35fC037B7B3212'

function parseArgs(argv) {
  const args = { chain: undefined, safe: DEFAULT_SAFE, label: '', file: undefined, format: 'v1' }
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
  if (link.length > SLACK_BUTTON_URL_LIMIT) {
    throw new Error(`Link is ${link.length} characters, which exceeds the Slack button url limit of ${SLACK_BUTTON_URL_LIMIT}`)
  }
  console.log(link)
}

main()

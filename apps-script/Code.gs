/**
 * Safe Batch Sender — Google Sheets helper.
 *
 * Builds a Safe deep link that opens https://hihiben.github.io/safe-batch-sender/
 * inside Safe{Wallet} with a batch of native-token transfers pre-filled.
 *
 * This is a standalone reimplementation of the payload v1 wire format from
 * src/payload.ts. Apps Script runs in a separate Google-hosted V8 sandbox with no
 * module system reachable from this repo, so the encoder can't be imported — it's
 * duplicated here on purpose. If the wire format ever changes, both sides must be
 * updated together; the fixture tests in the app's vitest suite
 * (src/__tests__/payload.test.ts) are what would catch a drift.
 *
 * Usage from a cell:
 *   =MAKE_BATCH_LINK("robinhood", "0xEeFa622109b5E97B98220729Fa35fC037B7B3212", A2:B10, "gas refill")
 *
 * rows: a 2-column range, one recipient per row: [address, amountWei]. Blank rows
 * (e.g. from passing A2:B100 when only 10 rows are filled) are skipped.
 */

var APP_HOST = 'https://hihiben.github.io/safe-batch-sender/'

var CHAIN_TABLE = [
  { chainId: '1', shortName: 'eth', aliases: ['mainnet', 'ethereum'] },
  { chainId: '100', shortName: 'gno', aliases: ['gnosis', 'xdai'] },
  { chainId: '42161', shortName: 'arb1', aliases: ['arbitrum'] },
  { chainId: '8453', shortName: 'base', aliases: [] },
  { chainId: '56', shortName: 'bnb', aliases: ['bsc'] },
  { chainId: '4663', shortName: 'robinhood', aliases: [] },
]

function resolveChain_(chainNameOrId) {
  var key = String(chainNameOrId).toLowerCase()
  for (var i = 0; i < CHAIN_TABLE.length; i++) {
    var entry = CHAIN_TABLE[i]
    if (entry.chainId === key || entry.shortName === key || entry.aliases.indexOf(key) !== -1) {
      return entry
    }
  }
  throw new Error('Unknown chain: ' + chainNameOrId + '. Known: ' + CHAIN_TABLE.map(function (c) { return c.shortName }).join(', '))
}

function encodePayloadWebSafe_(payload) {
  var json = JSON.stringify(payload)
  // Ben's reference link has no base64 padding; the app's decoder accepts both
  // padded and unpadded fragments, but stripping padding matches that convention.
  return Utilities.base64EncodeWebSafe(json, Utilities.Charset.UTF_8).replace(/=+$/, '')
}

/**
 * Builds the full Safe deep link for a batch of native-token transfers.
 * @param {string} chain Chain shortName or chainId, e.g. "robinhood" or "4663".
 * @param {string} safeAddress The Safe that will propose the transactions.
 * @param {Array<Array<string>>} rows A 2-column range: [[address, amountWei], ...].
 * @param {string} label Optional batch label shown in the app.
 * @return {string} The full app.safe.global deep link.
 * @customfunction
 */
function MAKE_BATCH_LINK(chain, safeAddress, rows, label) {
  var chainEntry = resolveChain_(chain)

  var normalizedRows = Array.isArray(rows[0]) ? rows : [rows]
  var txs = normalizedRows
    .filter(function (row) { return row[0] !== '' && row[0] != null && row[1] !== '' && row[1] != null })
    .map(function (row) { return [String(row[0]).trim(), String(row[1]).trim()] })

  if (txs.length === 0) {
    throw new Error('No non-empty [address, amountWei] rows found in the given range.')
  }

  var payload = { v: 1, chainId: chainEntry.chainId, safe: safeAddress, label: label || '', txs: txs }
  var fragment = encodePayloadWebSafe_(payload)
  var appUrl = APP_HOST + '#' + fragment

  return 'https://app.safe.global/apps/open?safe=' + chainEntry.shortName + ':' + safeAddress + '&appUrl=' + encodeURIComponent(appUrl)
}

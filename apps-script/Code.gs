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
 * rows: a 2-column range, one recipient per row: [address, amountWei]. Fully
 * blank rows (e.g. from passing A2:B100 when only 10 rows are filled) are
 * skipped, but a row with only one of the two cells filled, or a range with
 * more than two columns, throws rather than silently dropping data.
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

var POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/

/**
 * Sheets stores numeric cells as IEEE-754 floats. A wei amount typed into a
 * numeric cell can silently lose precision (`123456789012345678` becomes
 * `123456789012345680`) or get reformatted into scientific notation the app's
 * decoder rejects (`1e21`) — with no warning at the sheet. Refusing anything
 * but a plain-text cell here means that failure happens loudly, in the sheet,
 * instead of silently or three steps downstream in the app.
 */
function validateAmountCell_(value, rowLabel) {
  if (typeof value !== 'string') {
    throw new Error(
      rowLabel + ': amountWei must be plain text, got a ' + typeof value + ' (' + value + '). ' +
      'Set the amountWei column to plain text format (Format → Number → Plain text) before entering wei amounts.'
    )
  }
  if (!POSITIVE_INTEGER_RE.test(value)) {
    throw new Error(rowLabel + ': amountWei "' + value + '" is not a positive integer wei string.')
  }
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
  var txs = []
  for (var i = 0; i < normalizedRows.length; i++) {
    // "Row N" below is the row's position within the passed-in range, not its
    // absolute sheet row — a custom function only receives the range's values,
    // never the row numbers it came from. Pass A2:B10 and "Row 1" means the
    // range's first row (sheet row 2).
    var rowLabel = 'Row ' + (i + 1) + ' of the given range'
    var row = normalizedRows[i]

    if (row.length > 2) {
      throw new Error(rowLabel + ': range must be exactly two columns [address, amountWei], got ' + row.length + '. ERC-20 (a third column) is not supported yet — see README.')
    }

    var address = row[0]
    var amount = row[1]
    var addressBlank = address === '' || address == null
    var amountBlank = amount === '' || amount == null
    if (addressBlank && amountBlank) continue // fully empty row — expected when passing a range like A2:B100

    if (addressBlank || typeof address !== 'string' || address.trim() === '') {
      throw new Error(rowLabel + ': recipient address must be a non-empty text cell.')
    }
    validateAmountCell_(amount, rowLabel)

    txs.push([address.trim(), amount.trim()])
  }

  if (txs.length === 0) {
    throw new Error('No non-empty [address, amountWei] rows found in the given range.')
  }

  var payload = { v: 1, chainId: chainEntry.chainId, safe: safeAddress, label: label || '', txs: txs }
  var fragment = encodePayloadWebSafe_(payload)
  var appUrl = APP_HOST + '#' + fragment

  return 'https://app.safe.global/apps/open?safe=' + chainEntry.shortName + ':' + safeAddress + '&appUrl=' + encodeURIComponent(appUrl)
}

# Safe Batch Sender

A static custom [Safe App](https://docs.safe.global/safe-apps/introduction) that
proposes a batch of native-token transfers from a payload encoded directly in the
link — no backend. Built for topping up solver/filler gas across six chains from a
Google Sheet.

## How it works

1. A Google Sheet (via the Apps Script helper below) or `tools/make-link.mjs`
   builds a link like:

   ```
   https://app.safe.global/apps/open?safe=<shortName>:<safeAddress>&appUrl=<urlencoded appUrl>
   ```

   where `appUrl` is `https://hihiben.github.io/safe-batch-sender/#<payload>` and
   `<payload>` is base64url-encoded JSON in the URL **fragment** (not a query
   param — fragments never reach a server log, and Safe's manifest loader keeps
   the full fragment on the iframe's `src` even though it strips it before
   fetching `manifest.json`).

2. Opening the link loads this app inside the Safe iframe. It reads the fragment,
   validates it against the Safe you actually have open, and shows a preview.

3. One owner reviews the preview and clicks **Propose to Safe**, which signs and
   submits a single `MultiSend` transaction via `@safe-global/safe-apps-sdk`.
   Proposing still requires one owner's confirmation — there is no zero-click path
   (that would require a delegate key with propose rights, a different trust
   model, and is explicitly out of scope here).

Opening the app URL directly (outside the Safe iframe) shows a **read-only**
preview instead, using a static per-chain symbol table as a fallback — there is
no live Safe to validate against outside the iframe.

## Payload v1 (wire format)

```json
{
  "v": 1,
  "chainId": "4663",
  "safe": "0xEeFa622109b5E97B98220729Fa35fC037B7B3212",
  "label": "",
  "txs": [["0x9572561eBe198566bBa3B4e7C53F82Ac27587431", "500000000000000"]]
}
```

- `txs` entries must be exactly `[to, amountWei]` — native token only. A third
  element (a token address, for a future ERC-20 extension) is **rejected today**,
  not silently ignored: a decoder that accepted it while the preview and the
  proposed transaction stayed native-only would let a link say "5 DAI" and
  actually propose 5 ETH, with nothing in the UI to catch it. ERC-20 support
  will be introduced as a version bump (`v: 2`) once the preview and the
  proposed transaction both understand it, not by quietly accepting the syntax
  ahead of time.
- `txs` may contain at most `MAX_TXS` (100) entries — well above the observed
  41-row max, low enough that a malformed or malicious link can't force
  thousands of DOM rows into the preview.
- `amountWei` is a decimal string (positive integer, no sign/decimal/exponent).
- Addresses may be given all-lowercase, all-uppercase, or correctly
  EIP-55-checksummed. Mixed case that fails the checksum is rejected outright.
- The JSON is UTF-8 encoded, then base64url-encoded (`+`→`-`, `/`→`_`, no `=`
  padding), and placed after `#` in the app URL. The decoder also accepts
  padded base64url, in case a given encoder emits it.

**The `appUrl` query parameter must be fully percent-encoded**, including `#`
(`%23`) and `=` (`%3D`). An unencoded `#` truncates the URL at
`app.safe.global`'s own fragment boundary and the payload never reaches this
app at all — this is the single most common way to build a broken link.

## Supported chains

All six chains resolve through `app.safe.global` (verified against the Safe
config API, `safe-config.safe.global/api/v1/chains/`):

| chain     | chainId | shortName   | native symbol |
| --------- | ------- | ----------- | -------------- |
| mainnet   | 1       | `eth`       | ETH            |
| gnosis    | 100     | `gno`       | XDAI           |
| arbitrum  | 42161   | `arb1`      | AETH           |
| base      | 8453    | `base`      | ETH            |
| bnb       | 56      | `bnb`       | BNB            |
| robinhood | 4663    | `robinhood` | ETH            |

Note the native symbols that don't match the obvious guess: Arbitrum reports
`AETH`, not `ETH`; Gnosis reports `XDAI`. These come from Safe's own config,
not this app — inside the iframe the app always defers to
`sdk.safe.getChainInfo()` and only falls back to the table above when opened
outside Safe.

## Link length

Measured for the observed max batch size (41 rows, Base chain, real
`encodePayload` output): **3,853 characters** for the complete
`app.safe.global` deep link. This is far under any practical URL length limit
for both browsers and the Safe UI; `src/__tests__/link-budget.test.ts` asserts
it stays under 8,000 as a regression guard.

## First-run warning per chain

The first time this app is opened on a given chain, in a given browser, Safe
shows a one-time third-party-app disclaimer ("I understand the risks..."). This
is stored in `localStorage` per chain + origin, so it's a one-time click per
chain per browser (6 clicks total across all chains) — not a bug, just Safe's
normal behavior for any non-default Safe App.

## Development

```sh
npm install
npm run dev        # local dev server
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # outputs to dist/
```

## Google Sheets helper

`apps-script/Code.gs` exposes a custom function:

```
=MAKE_BATCH_LINK("robinhood", "0xEeFa622109b5E97B98220729Fa35fC037B7B3212", A2:B10, "gas refill")
```

`A2:B10` is a 2-column range of `[address, amountWei]` rows; fully blank rows
are skipped (so passing a generously-sized range like `A2:B100` is fine), but
a row with one cell filled and the other blank is treated as a mistake and
throws rather than being silently dropped. Paste `Code.gs` into the Sheet's
Apps Script editor (Extensions → Apps Script) to use it. This is a standalone
reimplementation of the payload encoder in Apps Script's own runtime (it can't
import `src/payload.ts` across that boundary) — see the file header for what
that means if the wire format ever changes.

**The `amountWei` column must be formatted as plain text**, not a number
(select the column → Format → Number → Plain text, *before* typing values in).
Sheets stores numeric cells as IEEE-754 floats: large wei amounts can lose
precision, or get reformatted into scientific notation (`1e+21`) that the
app's decoder rejects outright — either way, silently. `MAKE_BATCH_LINK` throws
immediately if a cell in that column isn't a text value, naming the row and
telling you to fix the column format, rather than letting a bad amount reach
a generated link.

## Local link generation (testing)

```sh
node tools/make-link.mjs --chain robinhood --label "gas refill test" rows.json
# rows.json: [["0xRecipient...", "500000000000000"], ...]
```

This imports the same `encodePayload` the app decodes with, so there is only
one encoder implementation in this repo (Apps Script is necessarily separate —
see above).

## Deployment

Pushing to `main` builds and deploys to GitHub Pages via
`.github/workflows/deploy.yml` (`configure-pages` with `enablement: true`, so
this also turns Pages on for the repo on first run). The deployed app lives at
`https://hihiben.github.io/safe-batch-sender/` — this exact URL is baked into
`tools/make-link.mjs` and `apps-script/Code.gs` as `APP_HOST`; moving the
static site to a new host means updating both, plus any already-generated
sheet links.

## Security notes

- No backend, no signing, no custom contracts. The app only ever calls
  `sdk.txs.send()`; Safe's own UI independently decodes and displays the
  `MultiSend` transaction before anyone signs, which is the real backstop
  against a malicious or malformed link.
- The preview renders every value with `textContent` only (never
  `innerHTML`); CI greps `src/` for `innerHTML`/`outerHTML`/
  `insertAdjacentHTML`/`document.write`/`eval(`/`new Function(` as a
  regression gate.
- Recipient addresses and amounts appear in the URL. They're placed after `#`
  (never sent to any server, including GitHub Pages itself), but do persist in
  local browser history. For gas-refill amounts this is treated as low
  sensitivity; re-evaluate before reusing this app for anything more
  sensitive.
- The Safe Apps SDK is initialized with `allowedDomains: [/^https:\/\/app\.safe\.global$/]`
  (`src/safe.ts`) so it only accepts postMessage responses from Safe's own
  origin — the SDK default is no restriction at all, which would let any page
  iframe this app on its real origin and drive a fake-but-fully-rendered
  "Propose to Safe" preview. If this app is ever opened through a self-hosted
  Safe{Wallet} fork instead of `app.safe.global`, that domain must be added to
  this list or the app will refuse to load inside it.

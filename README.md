# Safe Batch Sender

A static custom [Safe App](https://docs.safe.global/safe-apps/introduction) that
proposes a batch of native-token transfers from a payload encoded directly in the
link — no backend. Built for topping up solver/filler gas across six chains from a
Google Sheet.

## How it works

1. A link generator — the `gas-refill-util` Apps Script (see below) or
   `tools/make-link.mjs` — builds a link like:

   ```
   https://app.safe.global/apps/open?safe=<shortName>:<safeAddress>&appUrl=<urlencoded appUrl>
   ```

   where `appUrl` is `https://hihiben.github.io/safe-batch-sender/#<payload>` and
   `<payload>` is base64url-encoded JSON in the URL **fragment** (not a query
   param on *this* URL — GitHub Pages never sees it, and Safe's manifest loader
   keeps the full fragment on the iframe's `src` even though it strips it
   before fetching `manifest.json`). This does **not** mean the payload never
   reaches any server: percent-encoding turns `#` into `%23` in the complete
   `app.safe.global` deep link above, so the whole thing ends up as query-string
   data on that request instead — see "Security notes" below.

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
- `txs` may contain at most `MAX_TXS` (50) entries — above the observed
  41-row max, but with real headroom below `app.safe.global`'s actual link
  length limit (see "Link length" below) rather than an arbitrary round
  number.
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

**There is a real, hard limit, and it isn't the browser.** `app.safe.global` is
served through CloudFront/S3, which rejects any request whose total header
section (the request line — i.e. the URL — plus all headers) exceeds 8192
bytes, returning `400 RequestHeaderSectionTooLarge`. Measured empirically
against the live endpoint with synthetic addresses (Base chain, real
`encodePayload` output):

| rows | link length | result |
| ---- | ----------- | ------ |
| 41 (observed real-world max) | 3,853 chars | 200 |
| 50 (`MAX_TXS`) | 4,633 chars | 200 |
| 70 | 6,366 chars | ~edge |
| 75 | 6,799 chars | 400 |

Failure starts around 70 rows. Browser cookies count against the same
8192-byte budget, so a logged-in user's real safe margin is smaller than what
these curl-based measurements show — this hasn't been measured in an actual
browser session. `MAX_TXS` is capped at 50 for headroom below the observed
failure point, not just below the 41-row real-world max; `src/payload.ts`
rejects anything over that before a link can even be built.
`src/__tests__/link-budget.test.ts` asserts the complete deep link stays under
5,000 chars at both 41 and `MAX_TXS` rows, as a regression guard against this
budget silently eroding (e.g. a longer `label`, a chain with a longer
`shortName`, an app host with a longer path).

A link that does exceed the limit fails as an opaque S3/CloudFront XML error
page — not anything this app controls or can show a useful message for —
which is the reason for capping well below the observed edge rather than
riding right up to it.

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

## The production link generator

Links are generated by the **`gas-refill-util` Apps Script** (a separate,
local-only repo bound to the gas-tank Google Sheet), which serves the
`/topup-gastank` Slack command. Its `buildBatchLink(chain, project, amount)`
computes the per-tank top-ups from the sheet and emits the deep link described
above.

That is a **second implementation of the payload encoder**, because Apps Script
cannot import `src/payload.ts` across the runtime boundary. If the wire format
changes, both move together. Two things that side has to get right, and does:

- **Amounts** are built as wei strings by its own `ethToWei`, never by
  multiplying a float by `1e18` — `(0.1).toFixed(18)` is
  `"0.100000000000000006"`, and that error would reach the wei digits.
  Amounts that round to `0` wei are dropped, since `POSITIVE_INTEGER` would
  otherwise make this app reject the whole batch.
- **Recipient addresses are lowercased** before encoding. `normalizeAddress`
  re-checksums all-lowercase and all-uppercase input, but rejects mixed case
  that fails EIP-55 outright — and the sheet holds mixed-case checksummed
  addresses, so one damaged character would refuse the link. Lowercasing
  removes that failure class.

An earlier `apps-script/Code.gs` in this repo exposed a `MAKE_BATCH_LINK` custom
sheet function. It was a scratch harness used to confirm the Apps Script
encoding end of the chain and has been removed; the fixture it produced is kept
in `src/__tests__/payload.test.ts` as the evidence.

## Local link generation (testing)

```sh
node tools/make-link.mjs --chain robinhood --label "gas refill test" rows.json
# rows.json: [["0xRecipient...", "500000000000000"], ...]
```

This imports the same `encodePayload` the app decodes with, so there is only
one encoder implementation in this repo (the Apps Script side is necessarily
separate — see above).

**Node version**: `make-link.mjs` imports `../src/payload.ts` directly and
relies on Node's native TypeScript type-stripping support, which **Node 20
does not have** — confirmed by direct failure, both with and without
`--experimental-strip-types` (the flag doesn't exist on 20.19.6 at all:
`bad option: --experimental-strip-types`), and independently reproduced by
CI on Node 20.20.2 (`ERR_UNKNOWN_FILE_EXTENSION` for `.ts`). **Node 24 works
without any flag** — confirmed on 24.18.0/24.20.0 via direct binary
invocation. CI/deploy pin `node-version: 24` for this reason. Not verified on
Node 21/22/23. `src/__tests__/make-link.test.ts` spawns this script as a real
subprocess (via `process.execPath` — whatever Node is running the test) and
decodes its output back, so an incompatible Node version fails loudly via
`npm test` instead of only being discovered when someone runs it by hand.

## Deployment

Pushing to `main` builds and deploys to GitHub Pages via
`.github/workflows/deploy.yml` (`configure-pages` with `enablement: true`, so
this also turns Pages on for the repo on first run). The deployed app lives at
`https://hihiben.github.io/safe-batch-sender/` — this exact URL is baked in as
`APP_HOST` in `tools/make-link.mjs` here, and as `BATCH_SENDER_APP_HOST` in
`gas-refill-util`'s `GenerateGas.js`; moving the static site to a new host means
updating both, plus any already-generated links.

## Security notes

- No backend, no signing, no custom contracts. The app only ever calls
  `sdk.txs.send()`; Safe's own UI independently decodes and displays the
  `MultiSend` transaction before anyone signs, which is the real backstop
  against a malicious or malformed link.
- The preview renders every value with `textContent` only (never
  `innerHTML`); CI greps `src/` for `innerHTML`/`outerHTML`/
  `insertAdjacentHTML`/`document.write`/`eval(`/`new Function(` as a
  regression gate.
- Recipient addresses and amounts appear in the URL, and reach more places
  than "just this app". The fragment in `https://hihiben.github.io/…/#payload`
  is never sent to any server — that part is true, fragments aren't part of an
  HTTP request. But **the deep link an operator actually clicks is not that
  URL**: it's `https://app.safe.global/apps/open?safe=…&appUrl=<percent-encoded
  appUrl>`, and percent-encoding turns `#` into `%23` so it survives as part of
  a query string value. That means the whole payload **is** query-string data
  on a request to `app.safe.global`, which is served through CloudFront/S3 —
  it lands in their edge logs, and N1's 400 responses are direct proof the
  server receives and measures it before rejecting it. It also persists in
  local browser history on every hop. For gas-refill amounts this is treated
  as low sensitivity; re-evaluate before reusing this app for anything more
  sensitive.
- The Safe Apps SDK is initialized with `allowedDomains: [/^https:\/\/app\.safe\.global$/]`
  (`src/safe.ts`) so it only accepts postMessage responses from Safe's own
  origin — the SDK default is no restriction at all, which would let any page
  iframe this app on its real origin and drive a fake-but-fully-rendered
  "Propose to Safe" preview. If this app is ever opened through a self-hosted
  Safe{Wallet} fork instead of `app.safe.global`, that domain must be added to
  this list or the app will refuse to load inside it.

# Safe Batch Sender

A static custom [Safe App](https://docs.safe.global/safe-apps/introduction) that
proposes a batch of native-token transfers from a payload encoded directly in the
link — no backend, no database, nothing to operate. Anything that can build a URL
can drive it.

## How it works

1. Any link generator — `tools/make-link.mjs` in this repo, or your own — builds a
   link like:

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
  "safe": "0x3432931ca9f58f3943cE806039c799F0613871BD",
  "label": "",
  "txs": [["0x2701232ab142dfF035245dBcaA08e316Bf5d1B14", "500000000000000"]]
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

## Theme (dark mode inside Safe{Wallet})

- `@safe-global/safe-apps-sdk@9.1.0` has **no official theme API**: `Methods`
  (`node_modules/@safe-global/safe-apps-sdk/dist/types/communication/methods.d.ts`)
  has no theme-related member, and `EnvironmentInfo` is just `{ origin: string }`
  — confirmed by grepping the installed package for
  `darkMode|getCurrentTheme|prefers-color-scheme` (nothing).
- `index.html`'s CSS is correct with **no signal at all**. `:root` carries the
  palette as custom properties (light by default) plus `color-scheme: light
  dark`, and `@media (prefers-color-scheme: dark)` overrides them for a dark
  OS/browser. `body` sets `color` **and** `background-color` together, which is
  what makes the text-colour-only rules (`.error-title`, `.error-list`,
  `.success`) safe: they inherit an explicit background rather than a
  transparent one — the bug this fixes was `body` setting
  `color: #111` with **no `background-color` at all**, so inside Safe's dark
  iframe (which sets no background of its own either) the wallet's near-black
  page showed through and every value rendered dark-grey-on-black.
- `src/theme.ts` layers an **unofficial, best-effort** signal on top.
  Safe{Wallet} answers a raw postMessage method, `getCurrentTheme` →
  `{ darkMode: boolean }`, that isn't part of the SDK's `Methods` enum. See
  `safe-global/safe-wallet-monorepo` (branch `dev`):
  `apps/web/src/components/safe-apps/AppFrame/useAppCommunicator.ts` (the
  handler is marked `// TODO: it will be moved to safe-apps-sdk soon`, and
  there's a separate unsolicited push there that fires whenever the user
  toggles Safe's own theme) and
  `apps/web/src/services/safe-apps/AppCommunicator.ts` (`isValidMessage`
  explicitly whitelists `'getCurrentTheme'` even though it's outside the
  `Methods` enum). `startThemeSync()` sends the request through the SDK's own
  `MessageFormatter.makeRequest`, targeting `window.parent` at the explicit
  origin `https://app.safe.global` (never `'*'`), and only accepts a reply
  matching `{ data: { darkMode: boolean } }` from that exact origin. A valid
  reply sets `document.documentElement.dataset.theme`, which
  `:root[data-theme]` in `index.html` outranks `prefers-color-scheme` for
  (higher CSS specificity) — so an explicit Safe theme wins over the OS
  preference in both directions. It's called only on the in-iframe path, as
  early as possible (before the awaited `getSafeContext` call), so every
  screen — loading, error, and preview alike — picks it up, not just the
  preview table.
- This channel is unofficial and carries a `TODO` upstream: it may change or
  disappear without notice. It is **pure progressive enhancement** — if it
  never answers, or Safe removes it outright, the app renders exactly the
  `prefers-color-scheme` result, with no error and no flicker. The read-only
  path outside Safe never registers this listener at all and relies on the
  CSS alone.
- **When Safe's theme and the OS theme disagree, expect one visible switch.**
  The first paint can only use `prefers-color-scheme`; `data-theme` is set
  later, when the async reply lands. So a light-OS user inside a dark Safe
  sees the light palette flip to dark once. Both palettes set an explicit
  foreground *and* background, so no intermediate state is unreadable — but
  the "no flicker" guarantee above covers only the case where Safe never
  answers, not this one.

## Development

```sh
npm install
npm run dev        # local dev server
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # outputs to dist/
```

## Local link generation (testing)

```sh
node tools/make-link.mjs --chain robinhood --safe 0xYourSafe... --label "batch label" rows.json
# rows.json: [["0xRecipient...", "500000000000000"], ...]
```

`--chain` and `--safe` are both required — the tool has no default Safe, and
`0xYourSafe...` above is a placeholder the tool will reject: `--safe` is validated
with the wire format's own address rule for **both** formats, so a placeholder or a
bad EIP-55 checksum fails here with a message instead of producing a link that only
breaks once someone opens it in Safe. It
refuses to print a link longer than its `MAX_LINK_CHARS` (3000), which is the
limit of wherever the link gets published — chat platforms commonly cap a button's
URL at 3000 characters. That is a property of the consumer, not of the wire format,
which is why it lives in the tool rather than in `src/payload.ts`; change it there
if your carrier allows more.

This imports the same `encodePayload` the app decodes with, so there is only one
encoder implementation in this repo. A generator written outside it — in another
language or runtime — is necessarily a second implementation of the wire format,
and has to move with it; see the frozen fixtures in `src/__tests__/` for what such
an implementation is checked against.

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
`APP_HOST` in `tools/make-link.mjs`, and in whatever else generates links. Moving
the static site to a new host means updating every generator **and** invalidating
every link already handed out, because each one carries the old origin — put a
domain you control in front of the host before you need to move.

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
  local browser history on every hop. Recipients and amounts are therefore not
  private; decide whether that is acceptable for what you are sending before you
  use this.
- The Safe Apps SDK is initialized with `allowedDomains: [/^https:\/\/app\.safe\.global$/]`
  (`src/safe.ts`) so it only accepts postMessage responses from Safe's own
  origin — the SDK default is no restriction at all, which would let any page
  iframe this app on its real origin and drive a fake-but-fully-rendered
  "Propose to Safe" preview. If this app is ever opened through a self-hosted
  Safe{Wallet} fork instead of `app.safe.global`, that domain must be added to
  this list or the app will refuse to load inside it.

## License

MIT — see [LICENSE](LICENSE).

This proposes real transactions. The preview is the only thing between a link
and a batch someone signs, so read it, and review this code yourself before
using it with funds you care about.

# safe-batch-sender

A Safe App that reads a batch of native transfers out of its own URL, shows them, and proposes
them to the connected Safe. One static page, no build step, no dependencies, no backend.

It exists to replace the [CSV Airdrop](https://github.com/bh2smith/safe-airdrop) Safe App in
`gas-refill-util`'s `/topup-gastank` flow. That app is IPFS-hosted and its gateway has now failed
twice, and Safe's Transaction Builder cannot be deep-linked — its bundle never reads its own URL,
so every batch costs the operator a save-file-then-drag step.

## What it does, precisely

1. Safe loads this page in an iframe, with the batch in the URL fragment.
2. The page decodes the fragment, checks it (below), and renders a confirm table.
3. The button calls `sendTransactions` over `postMessage`.
4. **Safe** turns the batch into one Safe transaction and queues it. Owners sign it in Safe's UI.

What it therefore never does: hold a key, build MultiSend calldata, sign anything, broadcast
anything, or make a network request. The last one is enforced by the CSP — `default-src 'none'`
leaves no `connect-src`, so `fetch` is not available to this page at all.

## The payload

base64url-encoded JSON in the URL **fragment**:

```json
{
  "v": 1,
  "chainId": "4663",
  "safe": "0xEeFa622109b5E97B98220729Fa35fC037B7B3212",
  "label": "uniswapx gas top-up on robinhood",
  "txs": [["0x5F8D…", "10000000000000000"], ["0x5083…", "10000000000000000"]]
}
```

| Field | Rules |
|---|---|
| `v` | Must be exactly `1`. |
| `chainId` | Decimal string, one of `1`, `56`, `100`, `4663`, `8453`, `42161`. |
| `safe` | `0x` + 40 hex. Compared case-insensitively; EIP-55 casing is not identity. |
| `label` | Optional string. **Display-only** — no check consults it. |
| `txs` | Non-empty array of `[to, wei]` pairs. Pairs, not objects, to avoid repeating keys per row. |

Amounts are always integer **wei** strings, produced by `gas-refill-util`'s `ethToWei()`. An
unrecognised top-level field is a refusal, not something to ignore: a field silently dropped is a
field an attacker can hide meaning in.

Encoding is `Utilities.base64EncodeWebSafe(json, Utilities.Charset.UTF_8)` with `=` padding
stripped. The browser restores padding and decodes with `TextDecoder` in fatal mode — not bare
`atob`, which turns any multi-byte character in `label` into mojibake.

### Where the payload is visible

A browser does not send a fragment to the server, so **GitHub never sees the batch**. But the whole
app URL sits inside Safe's own query parameter
(`app.safe.global/apps/open?safe=…&appUrl=…%23<payload>`), so **`app.safe.global` does see it** in
its logs. The contents are gas-tank addresses and amounts that go on-chain publicly minutes later,
so this is acceptable — recorded here so nobody mistakes the fragment for a privacy boundary
against Safe.

## What it checks

Run on load, in order. **A failure means the send button is never created** — not a warning, not a
dismissible banner, no override checkbox. A warning gets clicked through; a missing button does not.

| # | Check | Where |
|---|---|---|
| 1 | The Safe interface answers `getSafeInfo` within our own deadline | `vendor/safe-client.js` |
| 2 | The fragment decodes, `v === 1`, and the schema matches exactly | `payload.js` |
| 3 | `chainId` equals the connected Safe's chain | `payload.js` |
| 4 | `safe` equals the connected Safe's address | `payload.js` |
| 6 | Every amount matches `/^[1-9][0-9]*$/` | `payload.js` |

Rule 1 failing is not a refusal — the batch is still rendered, read-only, so a suspicious link can
be inspected outside Safe. Numbering follows the design document, which is why there is no 5:

## What it does **not** check

**There is no recipient allowlist.** Rule 5 of the original design compiled the 42 gas-tank
addresses into the app and refused any batch naming an address outside them. It was removed on
2026-09-01, by decision, to keep the app stateless and free of a list that has to stay in sync with
a spreadsheet.

The consequence, stated plainly because it is the main risk this whole approach introduces:

> Anyone who can put a link in front of an owner can name arbitrary recipients. A forged link lives
> on the same domain, looks identical to the one the bot produces, and this app will display it
> exactly as it displays a real batch. A link lowers an attacker's cost from "get you to copy-paste
> a CSV" to "get you to click".

There is no compensating control in the app. What remains is that every transaction still needs an
owner's signature in Safe's UI — **and this Safe is 6 owners with threshold 1**, so one owner
clicking through is enough to execute. The confirm screen therefore says this on the same screen as
the button, and the only real defence is reading the recipients twice: here, and in Safe's modal.

Related, and also accepted: GitHub Pages serves one origin per account, so
`hihiben.github.io/safe-batch-sender/` shares `https://hihiben.github.io` with every other Pages
site on that account. `script-src 'self'` covers the whole origin. This is second-order — it needs
an XSS to matter, and the rules below close that — but it is the reason an org-owned origin would
be tighter.

## XSS rules

- **No markup-assigning API appears in the source.** `.github/workflows/ci.yml` greps for them and
  fails the build. The grep is literal and has no exception list, which is why the banned names are
  written down in exactly one place.
- Every value from the link reaches the DOM through `textContent`.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors https://app.safe.global`.

Why this matters more than it looks: our origin is the one allowed to call `sendTransactions`, so
script injection into this page would bypass the confirm screen entirely and leave Safe's modal as
the only remaining check.

### One CSP caveat, deliberately not papered over

**`frame-ancestors` does nothing here.** A CSP delivered in a `<meta>` element must ignore
`frame-ancestors` (also `report-uri` and `sandbox`), and GitHub Pages cannot set response headers.
So the directive is kept for the day this is served with real headers, and the check that actually
holds is in `vendor/safe-client.js`: it refuses messages from any origin but the pinned one, and
posts only to that origin. CI asserts the two values still agree.

That protects the *message path*, not *framing*: any page can still put this UI in an iframe. It
gains nothing by doing so — the button only exists after a real `getSafeInfo` reply from
`app.safe.global`.

## Why the SDK is hand-written

`vendor/safe-client.js` is ~60 lines implementing two methods, transcribed from Safe's own source
with the file paths cited in its header.

`@safe-global/safe-apps-sdk@9.1.0` ships no browser-consumable build: `type: module`, only
`dist/cjs` and `dist/esm`, no `browser` field, no UMD/IIFE, and `dist/esm` carries bare specifiers
a browser cannot resolve — `viem`, `@safe-global/safe-gateway-typescript-sdk`, and Node's built-in
`util`. Vendoring it would mean adding a bundler (this repo has no build step, on purpose) or
checking in an opaque bundle — which defeats the point of vendoring, namely that everything here is
auditable and diffable.

Two things the hand-written client does that the SDK does not, both explained in its header: it
gives `getSafeInfo` a deadline (the SDK's promise never settles when nothing answers, so rule 1 is
inexpressible with it), and it pins the parent origin. `sendTransactions` deliberately has **no**
deadline — the interface replies to it only once an owner has dealt with the signing modal.

## Files

```
index.html                     markup + CSP; no inline script or style
app.css                        no inline style, no web fonts (default-src 'none' blocks font-src)
app.js                         DOM wiring only
payload.js                     pure: decode, validate, format. Runs in the browser and under node
vendor/safe-client.js          the postMessage client, with provenance comments
manifest.json                  Safe App manifest: name + description + iconPath
icon.svg
tools/make-link.js             build a test link without going through Apps Script
test/                          node's built-in test runner, no dependencies
package.json                   exists only to mark the .js files as ESM for node. Nothing to install
```

## Tests

```sh
node --test test/          # or: npm test
```

No install step — there are no dependencies. Three layers:

- `test/payload.test.js` — each refusal rule, and the wei formatting (string padding only, never
  float, including the value that makes `toFixed(18)` drift).
- `test/safe-client.test.js` — the protocol against a fake Safe interface: the request envelope, the
  pinned origin, replies that must be ignored, and the deadline that makes rule 1 expressible.
- `test/render.test.js` — runs `app.js` itself against a small DOM stub (`test/dom-stub.js`) and a
  fake interface, asserting what the confirm screen says and, for every refusal, that the send
  button does not exist. This layer exists because a chained `append()` once looked correct and
  threw on every load; reading the file had not caught it.

Not covered by any of them: that the page renders in a real browser. Open the `app only` link below
to check that by eye.

## Local development

```sh
python3 -m http.server 8000
node tools/make-link.js --chain 4663 --safe 0xEeFa… 0xRecipient=0.0005
```

Two loops:

- **Fast, no Safe.** Open the `app only` link the tool prints. Rule 1 fails, so you get the
  read-only view: good for checking decoding, layout and refusal messages.
- **Real.** In Safe, *Apps → Add custom app*, and paste `http://localhost:8000`. Safe explicitly
  allows this — its URL validation is
  `protocolsAllowed.includes(protocol) || hostname.split('.').pop() === 'localhost'`, and the
  iframe accepts `http:`. Then open the `open in Safe` link.

  Unverified: whether the browser permits `https://app.safe.global` to `fetch`
  `http://localhost:8000/manifest.json`. Loopback is a potentially-trustworthy origin so it is not
  mixed content, but Chrome's Private Network Access may want a preflight. If it fails, serve the
  directory over local HTTPS (`mkcert`) instead. Safe's own docs advise matching the interface's
  protocol.

The custom app only ever needs registering once: Safe strips query and fragment
(`stripUrlParams()` → `origin + pathname`) when matching and when fetching the manifest, but the
iframe `src` keeps the full URL. Every later link with a different fragment works against the same
registration.

## Deploying

GitHub Pages from `main`. Verified suitable by response headers: `text/html`, no
`X-Frame-Options`, no restrictive CSP, and `access-control-allow-origin: *` so Safe can fetch
`manifest.json` cross-origin — even a 404 carries the CORS header.

`raw.githubusercontent.com` is **not** an option: it serves `text/plain` with
`x-content-type-options: nosniff` and `content-security-policy: default-src 'none'; …; sandbox`, so
the HTML does not render and no script runs.

## Status

**Prototype, on a personal account.** The design's repo-governance section — branch protection,
CODEOWNERS, an environment with deployment approval — is deferred, and `gas-refill-util`'s
`BATCH_SENDER_URL` is deliberately **not** pointed here yet.

Those controls exist to mitigate a real risk that is worth naming: anyone with push access to this
repo can make the confirm screen show honest amounts while proposing different ones. Note the
trade-off being accepted against what this replaces — an IPFS CID is content-addressed and cannot
be tampered with, only made unavailable. We are exchanging "unreliable but immutable" for "reliable
but mutable".

This is transaction-constructing code. It needs review before it is used on mainnet, and its first
run against real funds should be a small total (~0.001), stepping through the whole path and
checking every recipient and amount in Safe's modal before signing.

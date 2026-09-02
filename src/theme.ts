import { MessageFormatter, type Methods } from '@safe-global/safe-apps-sdk'

/**
 * `@safe-global/safe-apps-sdk@9.1.0` has no theme API at all — no method in
 * `Methods`, and `EnvironmentInfo` is just `{ origin: string }`. Safe{Wallet}
 * answers an unofficial raw postMessage method instead ('getCurrentTheme' /
 * `{ darkMode: boolean }`), which isn't in the `Methods` enum and carries a
 * `// TODO: it will be moved to safe-apps-sdk soon` upstream. See README for
 * the file references. This module is pure enhancement on top of the CSS's
 * own prefers-color-scheme handling in index.html: if this channel never
 * answers, or answers something we don't understand, the page must look
 * exactly like the CSS-only result, with no error and no flicker.
 */
const SAFE_ORIGIN = 'https://app.safe.global'

/** Sets the attribute index.html's :root[data-theme] rules key off. */
export function applyTheme(darkMode: boolean): void {
  document.documentElement.dataset.theme = darkMode ? 'dark' : 'light'
}

function extractDarkMode(data: unknown): boolean | undefined {
  if (typeof data !== 'object' || data === null || !('data' in data)) return undefined
  const inner = (data as { data?: unknown }).data
  if (typeof inner !== 'object' || inner === null || !('darkMode' in inner)) return undefined
  const darkMode = (inner as { darkMode?: unknown }).darkMode
  return typeof darkMode === 'boolean' ? darkMode : undefined
}

/**
 * Registers the listener first, then asks Safe for its current theme. Safe
 * also pushes this unsolicited whenever the user toggles their theme — the
 * listener has no `id` check, so both the reply to our request and any later
 * unsolicited push are handled the same way, which is what keeps us in sync
 * after the initial read.
 */
export function startThemeSync(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== SAFE_ORIGIN) return
    const darkMode = extractDarkMode(event.data)
    if (darkMode === undefined) return
    applyTheme(darkMode)
  })

  try {
    const request = MessageFormatter.makeRequest('getCurrentTheme' as Methods, {})
    window.parent.postMessage(request, SAFE_ORIGIN)
  } catch {
    // Unofficial channel, no guarantees. If postMessage itself rejects the
    // origin (e.g. this page isn't actually embedded by app.safe.global) the
    // CSS's prefers-color-scheme fallback still renders correctly — this
    // must never throw out of run().
  }
}

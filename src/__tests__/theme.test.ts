// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, startThemeSync } from '../theme.js'

const SAFE_ORIGIN = 'https://app.safe.global'

function postThemeMessage(origin: string, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { origin, data }))
}

beforeEach(() => {
  delete document.documentElement.dataset.theme
})

describe('applyTheme', () => {
  it('sets data-theme="dark" for true and "light" for false', () => {
    applyTheme(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    applyTheme(false)
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('startThemeSync', () => {
  it('posts a getCurrentTheme request to window.parent with an explicit app.safe.global target origin', () => {
    const spy = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    startThemeSync()
    expect(spy).toHaveBeenCalledTimes(1)
    const [message, targetOrigin] = spy.mock.calls[0]!
    expect((message as { method: string }).method).toBe('getCurrentTheme')
    expect(targetOrigin).toBe(SAFE_ORIGIN)
    spy.mockRestore()
  })

  it('does not throw even if window.parent.postMessage rejects the target origin (unofficial channel, pure enhancement)', () => {
    // happy-dom (like real browsers) throws a SecurityError when targetOrigin
    // doesn't match the actual recipient origin — this is the realistic shape
    // of "the channel is gone/changed", and must never surface to the caller.
    expect(() => startThemeSync()).not.toThrow()
  })

  it('flips data-theme on a valid { darkMode: boolean } response from the allowed origin', () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    startThemeSync()
    postThemeMessage(SAFE_ORIGIN, { id: 'req-1', success: true, data: { darkMode: true } })
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('ignores a message from a non-Safe origin', () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    startThemeSync()
    postThemeMessage('https://evil.example', { id: 'req-1', success: true, data: { darkMode: true } })
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('ignores a message with a non-boolean darkMode', () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    startThemeSync()
    postThemeMessage(SAFE_ORIGIN, { id: 'req-1', success: true, data: { darkMode: 'yes' } })
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('ignores a message with no data.darkMode at all', () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    startThemeSync()
    postThemeMessage(SAFE_ORIGIN, { id: 'req-1', success: true })
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('accepts a later, unsolicited message regardless of id — this is how a live theme toggle reaches us', () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    startThemeSync()
    postThemeMessage(SAFE_ORIGIN, { id: 'req-1', success: true, data: { darkMode: true } })
    expect(document.documentElement.dataset.theme).toBe('dark')

    // Safe's unsolicited push uses a fresh random id, unrelated to our request.
    postThemeMessage(SAFE_ORIGIN, { id: 'unsolicited-id', success: true, data: { darkMode: false } })
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

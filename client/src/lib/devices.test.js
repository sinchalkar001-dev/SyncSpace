import { describe, expect, it } from 'vitest'
import { ACTIVE_WINDOW_MS, describeDevice, isSessionActive } from './devices.js'

/**
 * Naming a browser from its User-Agent.
 *
 * The traps here are all the same shape: every Chromium browser also claims to
 * be Chrome and Safari, and every Android one also claims to be Linux. Order
 * is the whole implementation, so these tests are mostly about order.
 */

// Real headers, trimmed only of version noise that does not affect the answer.
const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/605.1.15',
  opera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0',
}

describe('describeDevice', () => {
  it('names the browser and the platform', () => {
    expect(describeDevice(UA.chromeWindows)).toBe('Chrome on Windows')
    expect(describeDevice(UA.safariMac)).toBe('Safari on macOS')
    expect(describeDevice(UA.firefoxLinux)).toBe('Firefox on Linux')
  })

  /** Edge and Opera both carry "Chrome/" — first match wins, so order matters. */
  it('is not fooled by browsers that claim to be Chrome', () => {
    expect(describeDevice(UA.edgeWindows)).toBe('Edge on Windows')
    expect(describeDevice(UA.opera)).toBe('Opera on Windows')
  })

  /** Chrome carries "Safari/" too, which is why Safari is checked last. */
  it('is not fooled by browsers that claim to be Safari', () => {
    expect(describeDevice(UA.chromeWindows)).toContain('Chrome')
    expect(describeDevice(UA.chromeWindows)).not.toContain('Safari')
  })

  /** An Android header also says Linux; a phone should not read as a desktop. */
  it('calls Android Android rather than Linux', () => {
    expect(describeDevice(UA.chromeAndroid)).toBe('Chrome on Android')
  })

  it('names phones by the phone, not by the Mac they impersonate', () => {
    expect(describeDevice(UA.safariIphone)).toBe('Safari on iPhone')
    expect(describeDevice(UA.firefoxIos)).toBe('Firefox on iPhone')
  })

  /**
   * A row with no label reads as a bug; "Unknown device" reads as a browser
   * nobody here has a name for. The address and time beside it are still true.
   */
  it('always answers something', () => {
    expect(describeDevice(null)).toBe('Unknown device')
    expect(describeDevice('')).toBe('Unknown device')
    expect(describeDevice(undefined)).toBe('Unknown device')
    expect(describeDevice('curl/8.4.0')).toBe('Unknown device')
    expect(describeDevice(12345)).toBe('Unknown device')
  })

  it('names what it recognises when it only recognises half', () => {
    expect(describeDevice('Something/1.0 (Windows NT 10.0)')).toBe('Windows')
    expect(describeDevice('Firefox/121.0')).toBe('Firefox')
  })
})

describe('isSessionActive', () => {
  const at = (msAgo) => ({ lastSeenAt: new Date(Date.now() - msAgo).toISOString() })

  it('counts a session used moments ago', () => {
    expect(isSessionActive(at(1000))).toBe(true)
  })

  it('does not count one last used hours ago', () => {
    expect(isSessionActive(at(4 * 60 * 60 * 1000))).toBe(false)
  })

  /**
   * The server refreshes `lastSeenAt` at most once a minute, so the window has
   * to be comfortably wider than that or a session in constant use would
   * flicker between active and not.
   */
  it('is wider than the interval the server refreshes on', () => {
    expect(ACTIVE_WINDOW_MS).toBeGreaterThan(60_000)
    expect(isSessionActive(at(90_000))).toBe(true)
  })

  it('says no rather than throwing when there is nothing to go on', () => {
    expect(isSessionActive(null)).toBe(false)
    expect(isSessionActive({})).toBe(false)
  })
})

/**
 * Turning a User-Agent header into something a person can recognise.
 *
 * The server stores the header raw, because naming browsers is presentation
 * and presentation changes more often than schemas. This is that naming, kept
 * deliberately small: enough to answer "is that row this laptop or my phone?",
 * which is the only question the device list asks of it.
 *
 * No library for it. The full parsers carry thousands of regexes to tell
 * crawlers and smart fridges apart, and the cost of being wrong here is a row
 * that reads "Unknown browser" beside an address and a time that are still
 * true — not a security decision.
 */

/** Order matters: every Chromium browser also claims to be Chrome and Safari. */
const BROWSERS = [
  { name: 'Edge', test: /\bEdg(?:e|A|iOS)?\//},
  { name: 'Opera', test: /\bOPR\/|\bOpera\// },
  { name: 'Samsung Internet', test: /SamsungBrowser\// },
  { name: 'Firefox', test: /\bFirefox\/|\bFxiOS\// },
  { name: 'Chrome', test: /\bChrome\/|\bCriOS\// },
  { name: 'Safari', test: /\bSafari\// },
]

/** Likewise: an Android UA also says Linux, and an iPad may say Macintosh. */
const PLATFORMS = [
  { name: 'Android', test: /\bAndroid\b/ },
  { name: 'iPhone', test: /\biPhone\b/ },
  { name: 'iPad', test: /\biPad\b/ },
  { name: 'Windows', test: /\bWindows\b/ },
  { name: 'macOS', test: /\bMac OS X\b|\bMacintosh\b/ },
  { name: 'Linux', test: /\bLinux\b|\bX11\b/ },
]

const match = (list, value) => list.find((entry) => entry.test.test(value))?.name ?? null

/**
 * A short label such as "Chrome on Windows".
 *
 * Answers something usable however little it recognises, because a row with no
 * label reads as a bug where "Unknown device" reads as a browser nobody here
 * has a name for.
 */
export function describeDevice(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') return 'Unknown device'

  const browser = match(BROWSERS, userAgent)
  const platform = match(PLATFORMS, userAgent)

  if (browser && platform) return browser + ' on ' + platform
  if (browser) return browser
  if (platform) return platform
  return 'Unknown device'
}

/**
 * Whether this session has been used recently enough to call it active.
 *
 * `lastSeenAt` is refreshed at most once a minute by the server, so the window
 * has to be comfortably wider than that or a session in constant use would
 * flicker in and out of looking active.
 */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000

export function isSessionActive(session) {
  if (!session?.lastSeenAt) return false
  return Date.now() - new Date(session.lastSeenAt).getTime() < ACTIVE_WINDOW_MS
}

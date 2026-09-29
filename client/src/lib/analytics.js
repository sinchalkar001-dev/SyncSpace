/**
 * What a page view may say about where it happened.
 *
 * An address here can be somebody's secret: a room code is the key to a
 * public room, and the links in emails carry one-time tokens in their query
 * string. The path is kept and those parts are not, so a room is counted as a
 * room, never as which one.
 */
export function redactPageView(event) {
  let url
  try {
    url = new URL(event.url)
  } catch {
    return null
  }

  const path = url.pathname.startsWith('/room/') ? '/room/[code]' : url.pathname
  return { ...event, url: url.origin + path }
}

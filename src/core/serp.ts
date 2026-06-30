// A SERP (search engine results page) is a navigational list of links to other pages,
// not readable content worth recalling. This is a SOFT signal for auto-capture only -
// manual save still works (the gate handles that). Pure URL check: host + results path,
// no page content, no DOM. Kept SEPARATE from the privacy denylist (different intent:
// "low value" vs "never store").
//
// Each entry: the engine's host (or host suffix) plus the path that means "results".
// Matching the path (not just the host) avoids flagging content sub-apps on the same
// host - e.g. google.com/maps, duckduckgo.com/about, bing.com/news are NOT SERPs.
export function isSerp(url: string): boolean {
  let host: string
  let path: string
  try {
    const u = new URL(url)
    host = u.hostname.toLowerCase()
    path = u.pathname.toLowerCase()
  } catch {
    return false
  }
  const hostIs = (suffix: string) => host === suffix || host.endsWith('.' + suffix)

  // /search engines (google, bing, yahoo, brave, ecosia, kagi).
  if (path === '/search' || path.startsWith('/search')) {
    if (
      hostIs('google.com') || hostIs('bing.com') || hostIs('yahoo.com') ||
      hostIs('brave.com') || hostIs('ecosia.org') || hostIs('kagi.com')
    ) return true
  }
  // Startpage results live under /sp/search.
  if (hostIs('startpage.com') && (path === '/sp/search' || path.startsWith('/sp/search'))) return true
  // DuckDuckGo: results live at the site root with a ?q= query (duckduckgo.com/?q=...)
  // or under /html (the no-JS results page).
  if (hostIs('duckduckgo.com')) {
    if ((path === '/' || path === '') && /[?&]q=/.test(url)) return true
    if (path === '/html' || path === '/html/') return true
  }
  // Baidu results: /s
  if (hostIs('baidu.com') && path === '/s') return true
  // Yandex results: /search/ (note trailing slash)
  if (hostIs('yandex.com') && (path === '/search' || path === '/search/')) return true
  return false
}

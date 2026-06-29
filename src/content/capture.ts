import { Readability } from '@mozilla/readability'
import type { Msg, MsgResult } from '../messaging'
import { DwellTracker } from './dwell-tracker'
import { sanitizeUrl } from '../core/sanitize-url'

const DWELL_MS = 10_000
const POLL_MS = 1_000

// Strip the hash so that scroll-spy / anchor nav on long pages (MDN, docs sites)
// does not look like a page change and does not reset the dwell timer.
// A real path/query change still resets because those differ before the hash.
function urlKey(href: string): string {
  try {
    const u = new URL(href)
    u.hash = ''
    return u.toString()
  } catch {
    return href
  }
}

function extract(): { title: string; text: string } | null {
  try {
    const docClone = document.cloneNode(true) as Document
    const article = new Readability(docClone).parse()
    const text = (article?.textContent?.trim()) || (document.body?.innerText ?? '')
    if (!text) return null
    return { title: article?.title ?? document.title, text }
  } catch {
    return null
  }
}

// Returns true when the page should be skipped by auto-capture:
// - a robots meta instructs crawlers/archivers not to index/archive the page, OR
// - a password input is currently visible (e.g. a login widget in the page header).
// Manual capture intentionally bypasses this check (explicit user intent wins).
function isSensitivePage(): boolean {
  const robotsMeta = document.querySelector('meta[name="robots" i]')
  if (robotsMeta) {
    const content = robotsMeta.getAttribute('content')?.toLowerCase() ?? ''
    if (content.includes('noindex') || content.includes('noarchive') || content.includes('none')) {
      return true
    }
  }
  const pwInputs = document.querySelectorAll('input[type="password"]')
  for (const el of pwInputs) {
    if ((el as HTMLElement).offsetParent !== null) return true
  }
  return false
}

function sendCapture(manual: boolean): void {
  const ex = extract()
  if (!ex) return
  const capture: Msg = { type: 'capture', url: sanitizeUrl(location.href), title: ex.title, text: ex.text, manual }
  chrome.runtime.sendMessage(capture, () => void chrome.runtime.lastError)
}

// Incognito is handled by the SW (it drops senders whose tab.incognito is true),
// and extensions do not inject content scripts in incognito unless explicitly allowed.
// We do NOT check chrome.extension here: chrome.extension is unreliable/undefined in
// MV3 content scripts and would throw, killing both auto- and manual-capture.
//
// Dwell counts VISIBLE time, not wall-clock: a page only auto-captures after the user
// has actually looked at it (tab visible / not hidden) for DWELL_MS. Background tabs
// (e.g. middle-click-opened links) never accumulate and are never captured. The logic
// lives in the pure, unit-tested DwellTracker; here we wire it to the real clock,
// document.visibilityState, the visibilitychange event, and a poll for SPA navigation.
//
// urlKey() strips the hash so scroll-spy rewriting of location.hash on a single page
// (MDN, docs, long articles) does NOT reset the dwell timer.
{
  let currentUrlKey = urlKey(location.href)
  const tracker = new DwellTracker(
    DWELL_MS,
    () => Date.now(),
    () => document.visibilityState === 'visible',
    () => {
      if (isSensitivePage()) return
      sendCapture(false)
    },
  )
  tracker.reset()
  document.addEventListener('visibilitychange', () => tracker.onVisibilityChange())
  setInterval(() => {
    const nextKey = urlKey(location.href)
    if (nextKey !== currentUrlKey) {
      currentUrlKey = nextKey // SPA navigation or bounce -> new candidate
      tracker.reset()
      return
    }
    tracker.tick()
  }, POLL_MS)
}

chrome.runtime.onMessage.addListener((msg: { type: 'extract-and-capture' }, _s, sendResponse) => {
  if (msg.type !== 'extract-and-capture') return
  const ex = extract()
  if (!ex) {
    sendResponse({ type: 'error', error: 'no extractable text' } satisfies MsgResult)
    return true
  }
  const capture: Msg = { type: 'capture', url: sanitizeUrl(location.href), title: ex.title, text: ex.text, manual: true }
  chrome.runtime.sendMessage(capture, (res: MsgResult) => sendResponse(res))
  return true
})

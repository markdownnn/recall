import { Readability } from '@mozilla/readability'
import type { Msg, MsgResult } from '../messaging'
import { DwellTracker } from './dwell-tracker'

const DWELL_MS = 10_000
const POLL_MS = 1_000

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

function sendCapture(manual: boolean): void {
  const ex = extract()
  if (!ex) return
  const capture: Msg = { type: 'capture', url: location.href, title: ex.title, text: ex.text, manual }
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
{
  let currentUrl = location.href
  const tracker = new DwellTracker(
    DWELL_MS,
    () => Date.now(),
    () => document.visibilityState === 'visible',
    () => sendCapture(false),
  )
  tracker.reset()
  document.addEventListener('visibilitychange', () => tracker.onVisibilityChange())
  setInterval(() => {
    if (location.href !== currentUrl) {
      currentUrl = location.href // SPA navigation or bounce -> new candidate
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
  const capture: Msg = { type: 'capture', url: location.href, title: ex.title, text: ex.text, manual: true }
  chrome.runtime.sendMessage(capture, (res: MsgResult) => sendResponse(res))
  return true
})

import { Readability } from '@mozilla/readability'
import type { Msg, MsgResult } from '../messaging'

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
// has actually looked at it (tab focused / not hidden) for DWELL_MS. Background tabs
// (e.g. middle-click-opened links) never accumulate and are never captured. The timer
// pauses when the tab is hidden and resumes when it becomes visible again.
{
  let currentUrl = ''
  let visibleMs = 0 // accumulated visible time for the current candidate
  let streakStart: number | null = null // start of the ongoing visible streak, or null if hidden
  let captured = false

  const isVisible = (): boolean => document.visibilityState === 'visible'

  const flushStreak = (): void => {
    if (streakStart !== null) {
      visibleMs += Date.now() - streakStart
      streakStart = null
    }
  }

  const startCandidate = (url: string): void => {
    currentUrl = url
    visibleMs = 0
    captured = false
    streakStart = isVisible() ? Date.now() : null
  }

  document.addEventListener('visibilitychange', () => {
    if (isVisible()) streakStart = Date.now()
    else flushStreak()
  })

  startCandidate(location.href)
  setInterval(() => {
    if (location.href !== currentUrl) {
      startCandidate(location.href) // SPA navigation or bounce -> new candidate
      return
    }
    if (captured) return
    const ongoing = streakStart !== null ? Date.now() - streakStart : 0
    if (visibleMs + ongoing >= DWELL_MS) {
      captured = true
      sendCapture(false)
    }
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

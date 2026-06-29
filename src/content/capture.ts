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
{
  let dwellTimer: ReturnType<typeof setTimeout> | undefined
  let currentUrl = ''
  const startCandidate = (url: string): void => {
    currentUrl = url
    if (dwellTimer) clearTimeout(dwellTimer)
    dwellTimer = setTimeout(() => sendCapture(false), DWELL_MS)
  }
  startCandidate(location.href)
  setInterval(() => {
    if (location.href !== currentUrl) startCandidate(location.href)
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

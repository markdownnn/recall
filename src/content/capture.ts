import { Readability } from '@mozilla/readability'
import type { Msg } from '../messaging'

chrome.runtime.onMessage.addListener((msg: { type: 'extract-and-capture' }, _s, sendResponse) => {
  if (msg.type !== 'extract-and-capture') return
  const docClone = document.cloneNode(true) as Document
  const article = new Readability(docClone).parse()
  const text = article?.textContent?.trim() ?? document.body.innerText
  const title = article?.title ?? document.title
  const capture: Msg = { type: 'capture', url: location.href, title, text }
  chrome.runtime.sendMessage(capture, () => sendResponse({ ok: true }))
  return true
})

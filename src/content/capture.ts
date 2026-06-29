import { Readability } from '@mozilla/readability'
import type { Msg, MsgResult } from '../messaging'

chrome.runtime.onMessage.addListener((msg: { type: 'extract-and-capture' }, _s, sendResponse) => {
  if (msg.type !== 'extract-and-capture') return
  console.log('[recall/cs] extract-and-capture received')
  try {
    const docClone = document.cloneNode(true) as Document
    const article = new Readability(docClone).parse()
    // Use || so an empty-string textContent falls through to body.innerText.
    // Guard document.body which may be null on XML/SVG/non-HTML documents.
    const text = (article?.textContent?.trim()) || (document.body?.innerText ?? '')
    console.log('[recall/cs] extracted text length =', text.length)
    if (!text) {
      sendResponse({ type: 'error', error: 'no extractable text' } satisfies MsgResult)
      return true
    }
    const title = article?.title ?? document.title
    const capture: Msg = { type: 'capture', url: location.href, title, text }
    console.log('[recall/cs] sent to background, awaiting response...')
    chrome.runtime.sendMessage(capture, (res: MsgResult) => {
      console.log('[recall/cs] background responded:', res?.type, chrome.runtime.lastError?.message ?? '')
      sendResponse(res)
    })
    return true
  } catch (e) {
    console.error('[recall/cs] extraction error:', e)
    sendResponse({ type: 'error', error: String(e) } satisfies MsgResult)
    return true
  }
})

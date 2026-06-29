import { useState } from 'preact/hooks'
import type { MsgResult } from '../../messaging'
import type { RankedResult } from '../../core/model'

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab.id!
}

export function App() {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])

  const capture = async () => {
    setStatus('capturing...')
    try {
      const res: MsgResult = await chrome.tabs.sendMessage(await activeTabId(), { type: 'extract-and-capture' })
      if (res?.type === 'captured') setStatus('captured')
      else setStatus('capture failed: ' + (res && 'error' in res ? res.error : 'unknown'))
    } catch (e) {
      setStatus('capture failed: ' + String(e))
    }
  }

  const search = async () => {
    const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recall', text: q, k: 5 })
    if (res.type === 'recalled') setResults(res.results)
    else if (res.type === 'error') setStatus(res.error)
  }

  return (
    <div style="padding: 12px;">
      <button onClick={capture}>Capture this page</button>
      <span style="margin-left:8px;">{status}</span>
      <hr />
      <input
        value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && search()}
        placeholder="recall..."
        style="width: 100%; box-sizing: border-box; padding: 6px;"
      />
      <ul style="list-style:none; padding:0;">
        {results.map((r) => (
          <li key={r.chunk.id} style="margin:8px 0; padding:8px; border:1px solid #eee;">
            <div style="font-size:13px;">{r.chunk.text}</div>
            <a href={r.page.url} target="_blank" style="font-size:11px; color:#888;">
              {r.page.title} ({r.score.toFixed(3)})
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

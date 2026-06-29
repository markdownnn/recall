import { useState, useEffect } from 'preact/hooks'
import type { MsgResult, ModelProgressMsg, IndexingProgressMsg } from '../../messaging'
import type { RankedResult } from '../../core/model'
import { INITIAL_MODEL_STATUS } from '../../core/model-progress'
import type { ModelStatus } from '../../core/model-progress'

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab.id!
}

export function App() {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])
  const [modelStatus, setModelStatus] = useState<ModelStatus>(INITIAL_MODEL_STATUS)

  useEffect(() => {
    // Query current model status on mount.
    chrome.runtime.sendMessage({ type: 'model-status' }).then((res: MsgResult) => {
      if (res?.type === 'model-status') setModelStatus(res.status)
    }).catch(() => {})

    // Subscribe to broadcasts from the background.
    const listener = (msg: ModelProgressMsg | IndexingProgressMsg) => {
      if (msg?.type === 'model-progress') setModelStatus(msg.status)
      if (msg?.type === 'indexing-progress') {
        if (msg.pending === 0) setStatus('indexed')
        else setStatus(`indexing... ${msg.embedded} done`)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [])

  const capture = async () => {
    setStatus('capturing...')
    try {
      const res: MsgResult = await chrome.tabs.sendMessage(await activeTabId(), { type: 'extract-and-capture' })
      if (res?.type === 'captured') {
        if (res.chunkCount > 0) setStatus(`captured (indexing ${res.chunkCount} chunks...)`)
        else setStatus('nothing to capture')
      } else {
        setStatus('capture failed: ' + (res && 'error' in res ? res.error : 'unknown'))
      }
    } catch (e) {
      setStatus('capture failed: ' + String(e))
    }
  }

  const search = async () => {
    const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recall', text: q, k: 5 })
    if (res.type === 'recalled') setResults(res.results)
    else if (res.type === 'error') setStatus(res.error)
  }

  function renderModelStatus() {
    if (modelStatus.state === 'loading') {
      return (
        <div style="font-size:11px; color:#666; margin-bottom:6px;">
          Loading model... {modelStatus.percent}%
          <div style="height:3px; background:#eee; border-radius:2px; margin-top:2px;">
            <div style={`height:3px; width:${modelStatus.percent}%; background:#4a90d9; border-radius:2px; transition:width 0.3s;`} />
          </div>
        </div>
      )
    }
    if (modelStatus.state === 'error') {
      return <div style="font-size:11px; color:#c00; margin-bottom:6px;">Model failed to load</div>
    }
    if (modelStatus.state === 'ready') {
      return <div style="font-size:11px; color:#4a9; margin-bottom:6px;">Model ready</div>
    }
    return null
  }

  return (
    <div style="padding: 12px;">
      {renderModelStatus()}
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

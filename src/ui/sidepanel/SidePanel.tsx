import { useState, useEffect } from 'preact/hooks'
import type { MsgResult, ModelProgressMsg, IndexingProgressMsg, IndexingErrorMsg } from '../../messaging'
import type { RankedResult } from '../../core/model'
import { INITIAL_MODEL_STATUS } from '../../core/model-progress'
import type { ModelStatus } from '../../core/model-progress'

// SPIKE-ONLY minimal side panel. It exists to PROVE the uncertain side-panel mechanics
// (build emit, messaging in/out, active-tab query + reactivity, capture round-trip) work
// from a side-panel-origin page - NOT to be the final UI. The full migration replaces it
// with SidePanel + ThisPageBar + Tabs + SearchTab per the plan. Handler logic is reused
// from src/ui/popup/App.tsx so the spike exercises the SAME real paths.

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url).hostname } catch { return '' }
}

export function SidePanel() {
  const [modelStatus, setModelStatus] = useState<ModelStatus>(INITIAL_MODEL_STATUS)
  const [pageHost, setPageHost] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  // Read the active CONTENT tab and show its host. Proves chrome.tabs.query from the panel
  // page returns the active content tab, not the panel itself (uncertainty #3).
  const refreshActiveTab = async () => {
    const tab = await activeTab().catch(() => undefined)
    setPageHost(hostOf(tab?.url))
  }

  useEffect(() => {
    // Messaging IN: ask the SW for model status on mount (uncertainty #2).
    chrome.runtime.sendMessage({ type: 'model-status' }).then((res: MsgResult) => {
      if (res?.type === 'model-status') setModelStatus(res.status)
    }).catch(() => {})

    // Active-tab reactivity: refresh the "this page" host on mount AND whenever the user
    // switches or reloads tabs (the panel persists, unlike the popup) - uncertainty #3.
    void refreshActiveTab()
    const onActivated = () => void refreshActiveTab()
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tab.active && (info.status === 'complete' || info.url)) void refreshActiveTab()
    }
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)

    // Progress broadcasts from the background (same as the popup).
    const listener = (msg: ModelProgressMsg | IndexingProgressMsg | IndexingErrorMsg) => {
      if (msg?.type === 'model-progress') setModelStatus(msg.status)
      if (msg?.type === 'indexing-progress') {
        if (msg.pending === 0) setStatus('indexed')
        else setStatus(`indexing... ${msg.embedded} done`)
      }
      if (msg?.type === 'indexing-error') setStatus(`indexing failed: ${msg.error}`)
    }
    chrome.runtime.onMessage.addListener(listener)

    return () => {
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [])

  // Capture round-trip from the panel page: ask the active content tab to extract-and-
  // capture (uncertainty #4). Same message the popup sends.
  const capture = async () => {
    setStatus('capturing...')
    try {
      const tab = await activeTab()
      const res: MsgResult = await chrome.tabs.sendMessage(tab!.id!, { type: 'extract-and-capture' })
      if (res?.type === 'captured') {
        if (res.captured && res.chunkCount > 0) setStatus(`captured (indexing ${res.chunkCount} chunks...)`)
        else if (!res.captured && res.reason === 'paused') setStatus('Paused - nothing is being saved')
        else if (!res.captured && res.reason === 'denylisted') setStatus('not saved: this site is on the no-remember list')
        else if (!res.captured) setStatus('nothing substantial to capture')
        else setStatus('nothing to capture')
      } else {
        setStatus('capture failed: ' + (res && 'error' in res ? res.error : 'unknown'))
      }
    } catch (e) {
      setStatus('capture failed: ' + String(e))
    }
  }

  // Recall round-trip from the panel page: sendMessage to the SW and render cards
  // (messaging OUT/IN - uncertainty #2).
  const search = async () => {
    if (!q.trim() || searching) return
    setSearching(true)
    setHasSearched(true)
    try {
      const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recall', text: q, k: 5 })
      if (res.type === 'recalled') setResults(res.results)
      else if (res.type === 'error') setStatus(res.error)
    } catch (e) {
      setStatus('search failed: ' + String(e))
    } finally {
      setSearching(false)
    }
  }

  function renderModelStatus() {
    if (modelStatus.state === 'loading') return <span class="status loading">Loading {modelStatus.percent}%</span>
    if (modelStatus.state === 'error') return <span class="status error">Model error</span>
    if (modelStatus.state === 'ready') return <span class="status">Ready</span>
    return <span class="status loading">starting...</span>
  }

  return (
    <div class="app">
      <div class="head">
        <span class="brand">Recall</span>
        {renderModelStatus()}
      </div>

      <div class="thispage">this page: <strong>{pageHost || '(none)'}</strong></div>
      <button class="capture" onClick={capture}>Capture this page</button>
      {status && <div class="note">{status}</div>}

      <hr class="rule" />

      <div class="searchbar">
        <input
          type="search"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="recall..."
        />
        <button class="searchbtn" onClick={search}>Search</button>
      </div>
      {searching && <div class="hint">searching...</div>}
      {!searching && hasSearched && results.length === 0 && <div class="hint">no results</div>}

      {results.length > 0 && (
        <div class="results">
          {results.map((r) => (
            <article class="card" key={r.chunk.id}>
              <a href={r.page.url} target="_blank" rel="noopener noreferrer">{r.page.title}</a>
              <p>{r.chunk.text}</p>
              <div class="meta">{hostOf(r.page.url)} &middot; {r.score.toFixed(2)}</div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

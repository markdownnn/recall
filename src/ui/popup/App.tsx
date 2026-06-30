import { useState, useEffect } from 'preact/hooks'
import type { MsgResult, ModelProgressMsg, IndexingProgressMsg, IndexingErrorMsg } from '../../messaging'
import type { RankedResult } from '../../core/model'
import { INITIAL_MODEL_STATUS } from '../../core/model-progress'
import type { ModelStatus } from '../../core/model-progress'
import { siteHost } from '../../core/site-host'

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab.id!
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

export function App() {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])
  const [modelStatus, setModelStatus] = useState<ModelStatus>(INITIAL_MODEL_STATUS)
  const [paused, setPaused] = useState(false)
  const [userDenyHosts, setUserDenyHosts] = useState<string[]>([])
  const [denyStatus, setDenyStatus] = useState('')
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  useEffect(() => {
    // Query current model status on mount.
    chrome.runtime.sendMessage({ type: 'model-status' }).then((res: MsgResult) => {
      if (res?.type === 'model-status') setModelStatus(res.status)
    }).catch(() => {})

    // Query settings on mount.
    chrome.runtime.sendMessage({ type: 'get-settings' }).then((res: MsgResult) => {
      if (res?.type === 'settings') {
        setPaused(res.paused)
        setUserDenyHosts(res.userDenyHosts)
      }
    }).catch(() => {})

    // Subscribe to broadcasts from the background.
    const listener = (msg: ModelProgressMsg | IndexingProgressMsg | IndexingErrorMsg) => {
      if (msg?.type === 'model-progress') setModelStatus(msg.status)
      if (msg?.type === 'indexing-progress') {
        if (msg.pending === 0) setStatus('indexed')
        else setStatus(`indexing... ${msg.embedded} done`)
      }
      // Clears the stuck "indexing..." when a fire-and-forget drain fails.
      if (msg?.type === 'indexing-error') setStatus(`indexing failed: ${msg.error}`)
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [])

  const togglePause = async (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked
    setPaused(checked)
    await chrome.runtime.sendMessage({ type: 'set-paused', paused: checked }).catch(() => {})
  }

  const denyHost = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const host = siteHost(new URL(tab.url!).hostname)
      if (userDenyHosts.includes(host)) {
        setDenyStatus(`Already on the no-remember list: ${host}`)
        return
      }
      let res: MsgResult
      try {
        res = await chrome.runtime.sendMessage({ type: 'deny-host', host })
      } catch {
        setDenyStatus('Could not add to no-remember list - please try again')
        return
      }
      if (res?.type !== 'ok') {
        setDenyStatus('Could not add to no-remember list - please try again')
        return
      }
      setUserDenyHosts((prev) => [...prev, host])
      setDenyStatus(`Won't remember ${host}`)
    } catch {
      setDenyStatus('Cannot add this page (restricted tab)')
    }
  }

  const removeDeny = async (h: string) => {
    let res: MsgResult
    try {
      res = await chrome.runtime.sendMessage({ type: 'remove-deny-host', host: h })
    } catch {
      setDenyStatus('Could not remove - please try again')
      return
    }
    if (res?.type !== 'ok') {
      setDenyStatus('Could not remove - please try again')
      return
    }
    setUserDenyHosts((prev) => prev.filter((x) => x !== h))
  }

  const forgetHost = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const host = siteHost(new URL(tab.url!).hostname)
      if (!window.confirm(`Delete ALL captured history from ${host} and its subdomains? This cannot be undone.`)) return
      let res: MsgResult
      try {
        res = await chrome.runtime.sendMessage({ type: 'forget-host', host })
      } catch {
        setDenyStatus('Could not forget - please try again')
        return
      }
      if (res?.type !== 'ok') {
        setDenyStatus('Could not forget - please try again')
        return
      }
      setDenyStatus(`Forgot everything from ${host}`)
    } catch {
      setDenyStatus('Cannot forget this page (restricted tab)')
    }
  }

  const capture = async () => {
    setStatus('capturing...')
    try {
      const res: MsgResult = await chrome.tabs.sendMessage(await activeTabId(), { type: 'extract-and-capture' })
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
    if (modelStatus.state === 'loading') {
      return (
        <small>
          Loading model... {modelStatus.percent}%
          <progress value={modelStatus.percent} max={100} />
        </small>
      )
    }
    if (modelStatus.state === 'error') {
      return <small>Model failed to load</small>
    }
    if (modelStatus.state === 'ready') {
      return <small>Model ready</small>
    }
    return null
  }

  return (
    <main class="container">
      {renderModelStatus()}

      <label>
        <input type="checkbox" role="switch" checked={paused} onChange={togglePause} />
        Pause capturing
      </label>
      {paused && <small>Paused - nothing is being saved</small>}

      <div class="row">
        <button class="secondary" onClick={denyHost}>
          {userDenyHosts.length > 0 && denyStatus.startsWith('Already') ? 'Already on no-remember list' : "Don't remember this site"}
        </button>
        <button class="secondary" onClick={forgetHost}>
          Forget this site's history
        </button>
      </div>
      {denyStatus && <small>{denyStatus}</small>}

      {userDenyHosts.length > 0 && (
        <details>
          <summary>No-remember sites</summary>
          {userDenyHosts.map((h) => (
            <div key={h} class="row">
              <span>{h}</span>
              <button class="secondary outline" onClick={() => removeDeny(h)}>remove</button>
            </div>
          ))}
        </details>
      )}

      <button onClick={capture}>Capture this page</button>
      {status && <small>{status}</small>}

      <hr />

      <input
        type="search"
        value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && search()}
        placeholder="recall..."
      />
      {searching && <small>searching...</small>}
      {!searching && hasSearched && results.length === 0 && <small>no results</small>}

      {results.map((r) => (
        <article key={r.chunk.id}>
          <a href={r.page.url} target="_blank" rel="noopener noreferrer">{r.page.title}</a>
          <p>{r.chunk.text}</p>
          <footer><small>{hostOf(r.page.url)} &middot; {r.score.toFixed(2)}</small></footer>
        </article>
      ))}
    </main>
  )
}

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
      <div style="margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:6px; font-size:13px;">
          <input type="checkbox" checked={paused} onChange={togglePause} />
          Pause capturing
        </label>
        {paused && (
          <div style="font-size:11px; color:#c66; margin-top:3px;">Paused - nothing is being saved</div>
        )}
      </div>
      <div style="margin-bottom:8px;">
        <button onClick={denyHost} style="font-size:12px;">
          {userDenyHosts.length > 0 && denyStatus.startsWith('Already') ? 'Already on no-remember list' : "Don't remember this site"}
        </button>
        <button onClick={forgetHost} style="font-size:12px; margin-left:6px;">
          Forget this site's history
        </button>
        {denyStatus && (
          <span style="margin-left:8px; font-size:11px; color:#888;">{denyStatus}</span>
        )}
      </div>
      {userDenyHosts.length > 0 && (
        <div style="font-size:11px; margin-bottom:8px;">
          <div style="color:#888;">No-remember sites:</div>
          {userDenyHosts.map((h) => (
            <div key={h} style="display:flex; justify-content:space-between; align-items:center;">
              <span>{h}</span>
              <button onClick={() => removeDeny(h)} style="font-size:10px;">remove</button>
            </div>
          ))}
        </div>
      )}
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
      {searching && (
        <div style="font-size:12px; color:#4a90d9; margin-top:6px;">searching...</div>
      )}
      {!searching && hasSearched && results.length === 0 && (
        <div style="font-size:12px; color:#888; margin-top:6px;">no results</div>
      )}
      <ul style="list-style:none; padding:0;">
        {results.map((r) => (
          <li key={r.chunk.id} style="margin:8px 0; padding:8px; border:1px solid #eee;">
            <div style="font-size:13px;">{r.chunk.text}</div>
            <a href={r.page.url} target="_blank" rel="noopener noreferrer" style="font-size:11px; color:#888;">
              {r.page.title} ({r.score.toFixed(3)})
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

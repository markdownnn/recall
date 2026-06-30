import { useState, useEffect } from 'preact/hooks'
import type { MsgResult, ModelProgressMsg, IndexingProgressMsg, IndexingErrorMsg, EmbedderDegradedMsg } from '../../messaging'
import { INITIAL_MODEL_STATUS } from '../../core/model-progress'
import type { ModelStatus } from '../../core/model-progress'
import { isCapturableUrl } from '../../core/is-capturable-url'
import { t } from './strings'
import { ThisPageBar } from './ThisPageBar'
import { IndexingIndicator } from './IndexingIndicator'
import { SearchTab } from './SearchTab'
import { HistoryTab } from './HistoryTab'
import { TabBar } from './Tabs'
import type { TabKey } from './Tabs'

// Root of the side panel. Owns: model status, the active tab key, AND the ONE combined
// capture/index `status` line - written by BOTH `capture()` and the indexing broadcast
// listener, rendered exactly once here (so `captured ...` -> `indexing... N done` ->
// `indexed` replace in sequence on a single line). ThisPageBar fires `capture` via the
// onCapture prop but renders no status of its own.
export function SidePanel() {
  const [modelStatus, setModelStatus] = useState<ModelStatus>(INITIAL_MODEL_STATUS)
  const [status, setStatus] = useState('')
  // Explicit indexing phase, derived from the EVENTS (not by sniffing the status string).
  // `indexing` is the on/off phase; `indexedCount` is the running `done` total shown in
  // the indicator. While `indexing` is true we render the animated indicator instead of
  // the plain status line.
  const [indexing, setIndexing] = useState(false)
  const [indexedCount, setIndexedCount] = useState(0)
  // Persistent degraded-embedder banner state. `degraded` is the embedder state (or null when
  // healthy); `degradedDismissed` hides the banner until the next degraded event re-shows it
  // (dismissible-but-recurring) so the user is never left unaware that search is broken/slow.
  const [degraded, setDegraded] = useState<'unavailable' | 'wasm' | null>(null)
  const [degradedDismissed, setDegradedDismissed] = useState(false)
  const [tab, setTab] = useState<TabKey>('search')
  // Bumped after a successful capture so ThisPageBar re-queries `has-page` and the SAVED
  // badge flips false->true without the user switching tabs.
  const [savedRefresh, setSavedRefresh] = useState(0)

  useEffect(() => {
    // Ask the SW for model status on mount.
    chrome.runtime.sendMessage({ type: 'model-status' }).then((res: MsgResult) => {
      if (res?.type === 'model-status') setModelStatus(res.status)
    }).catch(() => {})

    // DECLARATIVE seed: ask the offscreen for the current embed-queue snapshot. Opening the panel
    // mid-drain (e.g. after an auto-capture happened while the panel was closed) would otherwise
    // miss the indicator entirely, since the `indexing` phase is driven by FUTURE
    // indexing-progress events. Seed it from STATE so the indicator derives from the queue, not
    // from a manual capture() call.
    chrome.runtime.sendMessage({ type: 'indexing-status' }).then((res: MsgResult) => {
      if (res?.type === 'indexing-status' && res.pending > 0) {
        setIndexing(true)
        setIndexedCount(res.embedded)
      }
    }).catch(() => {})

    // Progress broadcasts from the background (moved from the popup, unchanged). These
    // write the SAME status line that capture() writes.
    const listener = (msg: ModelProgressMsg | IndexingProgressMsg | IndexingErrorMsg | EmbedderDegradedMsg) => {
      if (msg?.type === 'model-progress') setModelStatus(msg.status)
      if (msg?.type === 'embedder-degraded') {
        // Persistent banner: the on-device embedder is unavailable (no search) or slow (WASM).
        // A fresh event always re-shows the banner even if the user dismissed a prior one.
        setDegraded(msg.state)
        setDegradedDismissed(false)
      }
      if (msg?.type === 'indexing-progress') {
        if (msg.pending === 0) {
          // pending=0 is the "drain finished" signal: leave the indexing phase and show
          // the plain `indexed` status line (the e2e waits for getByText('indexed')).
          setIndexing(false)
          setStatus(t.indexed)
        } else {
          // Still draining: enter/stay in the indexing phase, update the live done count.
          setIndexing(true)
          setIndexedCount(msg.embedded)
        }
      }
      if (msg?.type === 'indexing-error') {
        setIndexing(false)
        setStatus(t.indexingFailed(msg.error))
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [])

  // Toggle support for Cmd/Ctrl+Shift+K: announce THIS panel's windowId to the SW over a named
  // port so the SW knows the panel is open in this window. When the same shortcut fires again,
  // the SW posts {type:'close-panel'} back over the port and we close ourselves. The SW removes
  // us from its open-set on port disconnect (panel closed by any means).
  useEffect(() => {
    let port: chrome.runtime.Port | null = null
    let cancelled = false

    // Reconnect on disconnect: when the SW is reaped (sleep/memory pressure), the port drops and
    // the SW forgets this panel is open, so the toggle shortcut would re-OPEN instead of closing.
    // Re-announcing our windowId on every (re)connect keeps the SW's open-set accurate so close
    // still works after an SW reap.
    const connect = (winId: number): void => {
      if (cancelled) return
      port = chrome.runtime.connect({ name: 'recall-panel' })
      port.postMessage({ windowId: winId })
      port.onMessage.addListener((m: { type?: string }) => {
        if (m?.type === 'close-panel') window.close()
      })
      port.onDisconnect.addListener(() => {
        if (cancelled) return
        port = null
        connect(winId) // SW went away; re-announce so the open-set stays correct
      })
    }

    chrome.windows.getCurrent().then((win) => {
      if (cancelled || win?.id == null) return
      connect(win.id)
    }).catch(() => {})
    return () => {
      cancelled = true
      try { port?.disconnect() } catch { /* already gone */ }
    }
  }, [])

  // Capture round-trip: ask the active content tab to extract-and-capture. Reads the active
  // tab itself, so it needs nothing from ThisPageBar.
  const capture = async () => {
    // A fresh capture leaves any prior indexing phase so the "capturing..." line shows.
    setIndexing(false)
    // Read the active tab FIRST. Restricted pages (chrome://, extension, new-tab, PDFs,
    // view-source) can never host a content script, so messaging them rejects with
    // "Receiving end does not exist". Guard here and show a friendly line instead.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
    if (!isCapturableUrl(activeTab?.url ?? '')) {
      setStatus(t.cannotCapturePage)
      return
    }
    setStatus(t.capturing)
    try {
      const res: MsgResult = await chrome.tabs.sendMessage(activeTab!.id!, { type: 'extract-and-capture' })
      if (res?.type === 'captured') {
        if (res.captured && res.chunkCount > 0) setStatus(t.capturedChunks(res.chunkCount))
        else if (!res.captured && res.reason === 'paused') setStatus(t.pausedNote)
        else if (!res.captured && res.reason === 'denylisted') setStatus(t.notSavedDenylisted)
        else if (!res.captured) setStatus(t.nothingSubstantial)
        else setStatus(t.nothingToCapture)
        // The page is now stored, so tell ThisPageBar to re-query the SAVED badge.
        setSavedRefresh((n) => n + 1)
      } else {
        setStatus(t.captureFailed(res && 'error' in res ? res.error : 'unknown'))
      }
    } catch {
      // The URL was capturable but the send still failed: the content script is missing
      // because this tab was opened BEFORE the extension was installed/reloaded (the
      // <all_urls> script only injects on page load). A refresh injects it.
      setStatus(t.reloadToCapture)
    }
  }

  function renderModelStatus() {
    if (modelStatus.state === 'loading') return <span class="status loading">{t.loadingPercent(modelStatus.percent)}</span>
    if (modelStatus.state === 'error') return <span class="status error">{t.modelError}</span>
    if (modelStatus.state === 'ready') return <span class="status">{t.modelReady}</span>
    return null
  }

  return (
    <div class="app">
      <div class="head">
        <span class="brand">{t.brand}</span>
        {renderModelStatus()}
      </div>

      {degraded && !degradedDismissed && (
        <div class={`banner ${degraded === 'unavailable' ? 'danger' : ''}`} role="status">
          <span>{degraded === 'unavailable' ? t.embedderUnavailable : t.embedderSlow}</span>
          <button
            class="banner-dismiss"
            type="button"
            aria-label="Dismiss"
            onClick={() => setDegradedDismissed(true)}
          >
            {'×'}
          </button>
        </div>
      )}

      <ThisPageBar onCapture={capture} refreshSignal={savedRefresh} />
      {indexing
        ? <IndexingIndicator done={indexedCount} />
        : status && <div class="note">{status}</div>}

      <hr class="rule" />

      <TabBar active={tab} onSelect={setTab} />
      {tab === 'search' && <SearchTab />}
      {tab === 'history' && <HistoryTab />}
    </div>
  )
}

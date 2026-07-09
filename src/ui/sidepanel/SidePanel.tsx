import { useState, useEffect } from 'preact/hooks'
import type { AskModelProgressMsg, MsgResult, ModelProgressMsg, EmbedderDegradedMsg } from '../../messaging'
import { INITIAL_MODEL_STATUS } from '../../core/model-progress'
import type { ModelStatus } from '../../core/model-progress'
import { INITIAL_ASK_MODEL_STATUS } from '../../core/ask-model-status'
import type { AskModelStatus } from '../../core/ask-model-status'
import { isCapturableUrl } from '../../core/is-capturable-url'
import { t } from './strings'
import { ThisPageBar } from './ThisPageBar'
import { SearchTab } from './SearchTab'
import { HistoryTab } from './HistoryTab'
import { SettingsTab } from './SettingsTab'
import { TabBar } from './Tabs'
import type { TabKey } from './Tabs'

// Root of the side panel. Owns: model status, the active tab key, the degraded-embedder banner,
// and a SMALL transient note shown ONLY for a BLOCKED/FAILED capture (paused / denylisted /
// thin / error). There is NO global indexing indicator and NO progress/"indexed" status text:
// the CURRENT page's save state (not saved / Saving... / saved) lives entirely on the
// ThisPageBar capture button + SAVED badge, which ThisPageBar re-evaluates per active tab. This
// removes the old shared/global indicator, so one tab's indexing can never leak onto another.
export function SidePanel() {
  const [modelStatus, setModelStatus] = useState<ModelStatus>(INITIAL_MODEL_STATUS)
  const [askModelStatus, setAskModelStatus] = useState<AskModelStatus>(INITIAL_ASK_MODEL_STATUS)
  // Transient capture-RESULT note, set ONLY when a capture is BLOCKED or FAILS. A SUCCESSFUL
  // capture writes NOTHING here - its feedback is the button/badge flipping to "Saving..." then
  // "saved". Cleared on every tab switch so a note about a previous page never rides along.
  const [status, setStatus] = useState('')
  // Persistent degraded-embedder banner state. `degraded` is the embedder state (or null when
  // healthy); `degradedDismissed` hides the banner until the next degraded event re-shows it
  // (dismissible-but-recurring) so the user is never left unaware that search is broken/slow.
  const [degraded, setDegraded] = useState<'unavailable' | 'wasm' | null>(null)
  const [degradedDismissed, setDegradedDismissed] = useState(false)
  const [tab, setTab] = useState<TabKey>('search')
  // Bumped after a capture so ThisPageBar re-queries has-page + page-pending for the active tab
  // (badge "not saved yet" -> "Saving..." -> "saved" without a manual tab switch).
  const [savedRefresh, setSavedRefresh] = useState(0)

  useEffect(() => {
    // Ask the SW for model status on mount.
    chrome.runtime.sendMessage({ type: 'model-status' }).then((res: MsgResult) => {
      if (res?.type === 'model-status') setModelStatus(res.status)
    }).catch(() => {})
    chrome.runtime.sendMessage({ type: 'ask-model-status' }).then((res: MsgResult) => {
      if (res?.type === 'ask-model-status') setAskModelStatus(res.status)
    }).catch(() => {})

    // Background broadcasts that THIS panel root still cares about: model load progress and the
    // degraded-embedder banner. The per-page indexing state is owned by ThisPageBar (it listens
    // to indexing-progress itself), so there is no indexing handling here anymore.
    const listener = (msg: ModelProgressMsg | AskModelProgressMsg | EmbedderDegradedMsg) => {
      if (msg?.type === 'model-progress') setModelStatus(msg.status)
      if (msg?.type === 'ask-model-progress') setAskModelStatus(msg.status)
      if (msg?.type === 'embedder-degraded') {
        // Persistent banner: the on-device embedder is unavailable (no search) or slow (WASM).
        // A fresh event always re-shows the banner even if the user dismissed a prior one.
        setDegraded(msg.state)
        setDegradedDismissed(false)
      }
    }
    chrome.runtime.onMessage.addListener(listener)

    // Clear the blocked/failed note when the user switches or reloads tabs, so a note about a
    // PREVIOUS page never lingers over a different one. (The per-page SAVE state is owned by
    // ThisPageBar, which re-queries on these same events.)
    const onActivated = () => setStatus('')
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo, tabArg: chrome.tabs.Tab) => {
      if (tabArg.active && (info.status === 'complete' || info.url)) setStatus('')
    }
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)

    return () => {
      chrome.runtime.onMessage.removeListener(listener)
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
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

  // Open the onboarding page in a NEW TAB so the user can re-read how Recall works. It is an
  // extension page on our own origin, so tabs.create can load it directly (no web-accessible
  // entry needed) - the same URL the SW opens on first install.
  const openOnboarding = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/onboarding/index.html') }).catch(() => {})
  }

  // Capture round-trip: ask the active content tab to extract-and-capture. Reads the active tab
  // itself, so it needs nothing from ThisPageBar. A SUCCESSFUL capture writes no status text -
  // the feedback is ThisPageBar's button/badge flipping to "Saving..." (then "saved"); only a
  // BLOCKED/FAILED outcome surfaces a brief note here.
  const capture = async () => {
    setStatus('') // clear any prior blocked/failed note
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
    // The button is disabled for non-capturable schemes, so capture() should not fire for them;
    // guard defensively and stay silent (the disabled button already says "Can't save this page").
    if (!isCapturableUrl(activeTab?.url ?? '')) return
    try {
      const res: MsgResult = await chrome.tabs.sendMessage(activeTab!.id!, { type: 'extract-and-capture' })
      if (res?.type !== 'captured') {
        setStatus(t.captureFailed(res && 'error' in res ? res.error : 'unknown'))
        return
      }
      // The page may now be stored with pending chunks; tell ThisPageBar to re-query the active
      // tab so its button/badge reflects "Saving..." (or stays "not saved yet" when blocked).
      setSavedRefresh((n) => n + 1)
      if (res.captured && res.chunkCount > 0) return // success: button/badge is the feedback
      if (res.captured) { setStatus(t.nothingToCapture); return }
      if (res.reason === 'paused') setStatus(t.pausedNote)
      else if (res.reason === 'denylisted') setStatus(t.notSavedDenylisted)
      else setStatus(t.nothingSubstantial)
    } catch {
      // The URL was capturable but the send still failed: the content script is missing because
      // this tab was opened BEFORE the extension was installed/reloaded (the <all_urls> script
      // only injects on page load). A refresh injects it.
      setStatus(t.reloadToCapture)
    }
  }

  const prepareAskModel = async () => {
    try {
      const res: MsgResult = await chrome.runtime.sendMessage({ type: 'prepare-ask-model' })
      if (res?.type === 'ask-model-status') setAskModelStatus(res.status)
    } catch (err) {
      setAskModelStatus({ state: 'error', percent: askModelStatus.percent, message: String(err) })
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
        <div class="head-actions">
          {renderModelStatus()}
          <button
            class="help"
            type="button"
            aria-label={t.helpTitle}
            title={t.helpTitle}
            onClick={openOnboarding}
          >
            {'?'}
          </button>
        </div>
      </div>

      {degraded && !degradedDismissed && (
        <div class={`banner ${degraded === 'unavailable' ? 'danger' : ''}`} role="status">
          <span>{degraded === 'unavailable' ? t.embedderUnavailable : t.embedderSlow}</span>
          <button
            class="banner-dismiss"
            type="button"
            aria-label={t.dismissAria}
            onClick={() => setDegradedDismissed(true)}
          >
            {'×'}
          </button>
        </div>
      )}

      <ThisPageBar onCapture={capture} refreshSignal={savedRefresh} modelStatus={modelStatus} />
      {status && <div class="note">{status}</div>}

      <hr class="rule" />

      <TabBar active={tab} onSelect={setTab} />
      {tab === 'search' && <SearchTab initialMode="search" />}
      {tab === 'ask' && (
        <SearchTab initialMode="ask" askModelStatus={askModelStatus} onPrepareAskModel={prepareAskModel} />
      )}
      {tab === 'history' && <HistoryTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  )
}

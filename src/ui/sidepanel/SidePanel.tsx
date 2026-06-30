import { useState, useEffect } from 'preact/hooks'
import type { MsgResult, ModelProgressMsg, IndexingProgressMsg, IndexingErrorMsg } from '../../messaging'
import { INITIAL_MODEL_STATUS } from '../../core/model-progress'
import type { ModelStatus } from '../../core/model-progress'
import { t } from './strings'
import { ThisPageBar } from './ThisPageBar'
import { SearchTab } from './SearchTab'
import { TabBar } from './Tabs'
import type { TabKey } from './Tabs'

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab.id!
}

// Root of the side panel. Owns: model status, the active tab key, AND the ONE combined
// capture/index `status` line - written by BOTH `capture()` and the indexing broadcast
// listener, rendered exactly once here (so `captured ...` -> `indexing... N done` ->
// `indexed` replace in sequence on a single line). ThisPageBar fires `capture` via the
// onCapture prop but renders no status of its own.
export function SidePanel() {
  const [modelStatus, setModelStatus] = useState<ModelStatus>(INITIAL_MODEL_STATUS)
  const [status, setStatus] = useState('')
  const [tab, setTab] = useState<TabKey>('search')

  useEffect(() => {
    // Ask the SW for model status on mount.
    chrome.runtime.sendMessage({ type: 'model-status' }).then((res: MsgResult) => {
      if (res?.type === 'model-status') setModelStatus(res.status)
    }).catch(() => {})

    // Progress broadcasts from the background (moved from the popup, unchanged). These
    // write the SAME status line that capture() writes.
    const listener = (msg: ModelProgressMsg | IndexingProgressMsg | IndexingErrorMsg) => {
      if (msg?.type === 'model-progress') setModelStatus(msg.status)
      if (msg?.type === 'indexing-progress') {
        if (msg.pending === 0) setStatus(t.indexed)
        else setStatus(t.indexingProgress(msg.embedded))
      }
      if (msg?.type === 'indexing-error') setStatus(t.indexingFailed(msg.error))
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [])

  // Capture round-trip: ask the active content tab to extract-and-capture. Reads the active
  // tab itself, so it needs nothing from ThisPageBar.
  const capture = async () => {
    setStatus(t.capturing)
    try {
      const res: MsgResult = await chrome.tabs.sendMessage(await activeTabId(), { type: 'extract-and-capture' })
      if (res?.type === 'captured') {
        if (res.captured && res.chunkCount > 0) setStatus(t.capturedChunks(res.chunkCount))
        else if (!res.captured && res.reason === 'paused') setStatus(t.pausedNote)
        else if (!res.captured && res.reason === 'denylisted') setStatus(t.notSavedDenylisted)
        else if (!res.captured) setStatus(t.nothingSubstantial)
        else setStatus(t.nothingToCapture)
      } else {
        setStatus(t.captureFailed(res && 'error' in res ? res.error : 'unknown'))
      }
    } catch (e) {
      setStatus(t.captureFailed(String(e)))
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

      <ThisPageBar onCapture={capture} />
      {status && <div class="note">{status}</div>}

      <hr class="rule" />

      <TabBar active={tab} onSelect={setTab} />
      {tab === 'search' && <SearchTab />}
    </div>
  )
}

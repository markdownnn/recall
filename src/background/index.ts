// Service Worker: thin relay.
// Receives messages from popup/content, forwards to the offscreen via RPC,
// re-broadcasts progress events to the popup.
// No core services, no store, no embedder here.

import type { Msg, MsgResult } from '../messaging'
import type { AskAnswer, RankedResult } from '../core/model'
import { INITIAL_MODEL_STATUS, reduceModelProgress } from '../core/model-progress'
import type { ModelStatus } from '../core/model-progress'
import {
  callOffscreen,
  installSwRpcListener,
  registerOffscreenEnsurer,
} from '../offscreen/offscreen-rpc'

// Vite's module-preload error handler calls window.dispatchEvent(), which does
// not exist in a service worker.
if (typeof window === 'undefined') {
  (self as unknown as { window: typeof globalThis }).window = self as unknown as typeof globalThis
}

console.log('[recall/bg] service worker evaluated (thin relay)')

// ---------------------------------------------------------------------------
// Offscreen lifecycle
// ---------------------------------------------------------------------------

let _offscreenDocP: Promise<void> | null = null

// Serialize creation: concurrent callers all share the ONE in-flight promise, so
// two retries can never both call createDocument() and trigger Chrome's "Only a
// single offscreen document may be created" error. We never null _offscreenDocP
// while a creation is in flight.
function ensureOffscreen(): Promise<void> {
  if (_offscreenDocP) return _offscreenDocP
  _offscreenDocP = createOffscreenOnce()
  return _offscreenDocP
}

async function createOffscreenOnce(): Promise<void> {
  try {
    const exists = await chrome.offscreen?.hasDocument?.()
    if (exists) return
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
      reasons: ['BLOBS'],
      justification: 'OPFS sqlite + WebGPU embedder via offscreen document',
    })
  } catch (e) {
    // A "single offscreen document may be created"/"already exists" race means
    // the document actually exists now — treat as SUCCESS by re-checking.
    const existsNow = await chrome.offscreen?.hasDocument?.().catch(() => false)
    if (existsNow) return
    // Real failure: clear the cached promise so the NEXT call retries instead of
    // replaying this rejection forever.
    _offscreenDocP = null
    throw e
  }
}

function resetOffscreen(): void {
  _offscreenDocP = null
}

installSwRpcListener()
registerOffscreenEnsurer(ensureOffscreen, resetOffscreen)

// Open-panel ports: each side panel page connects on mount (name 'recall-panel') and posts
// its {windowId}. We keep a windowId -> port map so the open-panel command can tell whether a
// panel is already open in the active window and, if so, post a close signal back to it. The
// port disconnects when the panel closes (by any means), so the map self-cleans.
const panelPorts = new Map<number, chrome.runtime.Port>()
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'recall-panel') return
  let windowId: number | null = null
  port.onMessage.addListener((m: { windowId?: number }) => {
    if (typeof m?.windowId === 'number') {
      windowId = m.windowId
      panelPorts.set(windowId, port)
    }
  })
  port.onDisconnect.addListener(() => {
    // Guard the delete: a panel RELOAD connects a NEW port for the same windowId BEFORE the old
    // port's disconnect fires. Deleting unconditionally would wipe the live new entry and break
    // the toggle. Only delete if THIS port is still the one we have mapped.
    if (windowId != null && panelPorts.get(windowId) === port) panelPorts.delete(windowId)
  })
})

// Keyboard shortcut open-panel (Ctrl/Cmd+Shift+K): TOGGLE the side panel.
// - If a panel is already open in the active window (its port is in panelPorts), post
//   {type:'close-panel'} so the panel page calls window.close() on itself.
// - Otherwise open it. chrome.sidePanel.open() MUST be called SYNCHRONOUSLY in the gesture
//   handler - hopping through an async callback loses the user gesture and Chrome throws. The
//   panelPorts check is synchronous, so the gesture is preserved on the open path. We use the
//   `tab` arg the listener already passes (onCommand fires with (command, tab)) for windowId.
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== 'open-panel') return
  const windowId = tab?.windowId
  if (windowId == null) return
  const port = panelPorts.get(windowId)
  if (port) {
    port.postMessage({ type: 'close-panel' })
  } else {
    chrome.sidePanel.open({ windowId }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Model status (SW tracks the latest status from rpc-events; popup reads it)
// ---------------------------------------------------------------------------

let modelStatus: ModelStatus = INITIAL_MODEL_STATUS

function broadcastModelStatus(status: ModelStatus): void {
  chrome.runtime.sendMessage({ type: 'model-progress', status }).catch(() => {})
}

function broadcastIndexingProgress(pending: number, embedded: number, total?: number): void {
  chrome.runtime.sendMessage({ type: 'indexing-progress', pending, embedded, total }).catch(() => {})
}

// ---------------------------------------------------------------------------
// rpc-event relay: offscreen -> SW -> popup
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: any): boolean => {
  if (msg?.channel !== 'rpc-event') return false

  if (msg?.kind === 'model-progress') {
    const e = msg.status as { status: string; progress?: number }
    modelStatus = reduceModelProgress(modelStatus, e)
    broadcastModelStatus(modelStatus)
  } else if (msg?.kind === 'indexing-progress') {
    // pending=1 means "still going"; embedded is the running total. `total` (page count) is
    // present only during the model-swap re-index, letting the panel show a real "N of M" bar.
    broadcastIndexingProgress(1, (msg.embedded as number) ?? 0, msg.total as number | undefined)
  } else if (msg?.kind === 'indexing-complete') {
    // pending=0 signals "done" to the popup UI.
    const total = (msg.totalEmbedded as number) ?? 0
    broadcastIndexingProgress(0, total)
    if (total > 0) {
      modelStatus = { state: 'ready', percent: 100 }
      broadcastModelStatus(modelStatus)
    }
  } else if (msg?.kind === 'indexing-error') {
    // A fire-and-forget drain failed in the offscreen. Relay to the popup so it
    // can clear the stuck "indexing..." state instead of hanging forever.
    chrome.runtime
      .sendMessage({ type: 'indexing-error', error: String(msg.error ?? 'unknown') })
      .catch(() => {})
  } else if (msg?.kind === 'embedder-degraded') {
    // The embedder loaded on WASM (state:'wasm', running slow) OR could not load at all
    // (state:'unavailable', no on-device search on this hardware). Relay to the panel so it
    // can show the matching notice. UI consume is a follow-up; this just makes the signal
    // reachable instead of a buried offscreen warn.
    chrome.runtime
      .sendMessage({ type: 'embedder-degraded', state: msg.state })
      .catch(() => {})
  }

  return false
})

// ---------------------------------------------------------------------------
// Message router: capture / recall / model-status -> offscreen RPC
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
  if (msg.type === 'model-status') {
    // A freshly-woken SW has modelStatus = INITIAL even when the model is
    // actually loaded in the (surviving) offscreen. Ask the offscreen for the
    // truth; if it reports a loaded device, report ready. Fall back to the local
    // status if the offscreen is unreachable.
    ;(async () => {
      if (modelStatus.state !== 'ready') {
        try {
          const r = await callOffscreen<{ device: string | null }>(
            { op: 'status' },
            { timeoutMs: 5_000 },
          )
          if (r.device) modelStatus = { state: 'ready', percent: 100 }
        } catch {
          // offscreen not reachable yet; keep the local status.
        }
      }
      sendResponse({ type: 'model-status', status: modelStatus } satisfies MsgResult)
    })()
    return true
  }

  if (
    msg.type !== 'capture' &&
    msg.type !== 'capture-text' &&
    msg.type !== 'recall' &&
    msg.type !== 'ask' &&
    msg.type !== 'get-settings' &&
    msg.type !== 'set-paused' &&
    msg.type !== 'deny-host' &&
    msg.type !== 'remove-deny-host' &&
    msg.type !== 'forget-host' &&
    msg.type !== 'has-page' &&
    msg.type !== 'page-pending' &&
    msg.type !== 'recent-pages'
  ) return false

  ;(async () => {
    try {
      await ensureOffscreen()

      if (msg.type === 'capture') {
        if (sender.tab?.incognito) {
          sendResponse({ type: 'captured', captured: false, chunkCount: 0 } satisfies MsgResult)
          return
        }
        const r = await callOffscreen<{ captured: boolean; chunkCount: number; reason?: 'paused' | 'denylisted' | 'thin' }>({
          op: 'capture',
          url: msg.url,
          title: msg.title,
          text: msg.text,
          manual: msg.manual,
        })
        sendResponse({ type: 'captured', captured: r.captured, chunkCount: r.chunkCount, reason: r.reason } satisfies MsgResult)
      } else if (msg.type === 'capture-text') {
        const r = await callOffscreen<{ captured: boolean; chunkCount: number }>({
          op: 'capture-text',
          url: msg.url,
          title: msg.title,
          text: msg.text,
        })
        sendResponse({ type: 'captured', captured: r.captured, chunkCount: r.chunkCount } satisfies MsgResult)
      } else if (msg.type === 'recall') {
        const r = await callOffscreen<{ results: RankedResult[] }>({
          op: 'recall',
          text: msg.text,
          k: msg.k,
        })
        console.log('[recall/bg] recall: DONE, results =', r.results.length)
        modelStatus = { state: 'ready', percent: 100 }
        broadcastModelStatus(modelStatus)
        sendResponse({ type: 'recalled', results: r.results } satisfies MsgResult)
      } else if (msg.type === 'ask') {
        const r = await callOffscreen<{ answer: AskAnswer }>({
          op: 'ask',
          text: msg.text,
          retrieveK: msg.retrieveK,
          contextK: msg.contextK,
        })
        modelStatus = { state: 'ready', percent: 100 }
        broadcastModelStatus(modelStatus)
        sendResponse({ type: 'asked', answer: r.answer } satisfies MsgResult)
      } else if (msg.type === 'get-settings') {
        const r = await callOffscreen<{ paused: boolean; userDenyHosts: string[] }>({ op: 'get-settings' })
        sendResponse({ type: 'settings', paused: r.paused, userDenyHosts: r.userDenyHosts } satisfies MsgResult)
      } else if (msg.type === 'set-paused') {
        await callOffscreen({ op: 'set-paused', paused: msg.paused })
        sendResponse({ type: 'ok' } satisfies MsgResult)
      } else if (msg.type === 'deny-host') {
        await callOffscreen({ op: 'deny-host', host: msg.host })
        sendResponse({ type: 'ok' } satisfies MsgResult)
      } else if (msg.type === 'remove-deny-host') {
        await callOffscreen({ op: 'remove-deny-host', host: msg.host })
        sendResponse({ type: 'ok' } satisfies MsgResult)
      } else if (msg.type === 'forget-host') {
        await callOffscreen({ op: 'forget-host', host: msg.host })
        sendResponse({ type: 'ok' } satisfies MsgResult)
      } else if (msg.type === 'has-page') {
        const r = await callOffscreen<{ exists: boolean }>({ op: 'has-page', url: msg.url })
        sendResponse({ type: 'page-status', exists: r.exists } satisfies MsgResult)
      } else if (msg.type === 'page-pending') {
        const r = await callOffscreen<{ pending: boolean }>({ op: 'page-pending', url: msg.url })
        sendResponse({ type: 'page-pending-status', pending: r.pending } satisfies MsgResult)
      } else if (msg.type === 'recent-pages') {
        const r = await callOffscreen<{ pages: import('../core/model').CapturedPage[] }>(
          { op: 'recent-pages', limit: msg.limit, beforeTs: msg.beforeTs },
        )
        sendResponse({ type: 'pages', pages: r.pages } satisfies MsgResult)
      }
    } catch (err) {
      console.error('[recall/bg]', msg.type, 'FAILED:', err)
      modelStatus = { state: 'error', percent: modelStatus.percent }
      broadcastModelStatus(modelStatus)
      sendResponse({ type: 'error', error: String(err) } satisfies MsgResult)
    }
  })()
  return true
})

// ---------------------------------------------------------------------------
// Pre-warm: create the offscreen and load the model up front so the first
// capture/recall does not silently pay the ~20s model load.
// The offscreen document does NOT survive a browser restart, so we run this on
// BOTH onInstalled and onStartup.
// Model load can take ~20s on WebGPU and minutes on WASM, so use a long RPC
// timeout — the default 30s would kill a slow WASM load mid-flight.
// ---------------------------------------------------------------------------

const MODEL_LOAD_TIMEOUT_MS = 300_000 // 5 min

async function prewarm(trigger: string): Promise<void> {
  console.log(`[recall/bg] ${trigger}: pre-warming model in offscreen...`)
  try {
    await ensureOffscreen()
    const r = await callOffscreen<{ device: string }>(
      { op: 'ensureLoaded' },
      { timeoutMs: MODEL_LOAD_TIMEOUT_MS },
    )
    console.log('[recall/bg] pre-warm complete: device =', r.device)
    modelStatus = { state: 'ready', percent: 100 }
    broadcastModelStatus(modelStatus)
  } catch (e) {
    console.error('[recall/bg] pre-warm FAILED:', e)
    modelStatus = { state: 'error', percent: modelStatus.percent }
  }
}

// Side-panel SPIKE (additive): make the toolbar icon open the side panel. The SW is not
// durable, so set the behavior on BOTH install and startup. The ?. + catch keep an old
// Chrome (no sidePanel API) from throwing. The popup still exists, but with this set
// Chrome opens the PANEL on icon click - the mechanic this spike validates.
function enableSidePanelOnActionClick(): void {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
}

chrome.runtime.onInstalled.addListener((details) => {
  enableSidePanelOnActionClick()
  registerRedrainAlarm()
  void prewarm('onInstalled')
  // Show the onboarding page in a new tab on FIRST install only (not on update/
  // chrome_update). It's an extension page on our own origin, so tabs.create can
  // load it directly without a web_accessible_resources entry.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/onboarding/index.html') })
  }
})

chrome.runtime.onStartup.addListener(() => {
  enableSidePanelOnActionClick()
  registerRedrainAlarm()
  void prewarm('onStartup')
})

// ---------------------------------------------------------------------------
// Keep-alive: ping the offscreen every 20s so Chrome does not reap it (the reap
// timer is 30s; 20s leaves margin — ADR 0014). This keeps the model resident
// across captures.
// ---------------------------------------------------------------------------

setInterval(() => {
  callOffscreen({ op: 'ping' }).catch(() => {})
}, 20_000)

// ---------------------------------------------------------------------------
// SW-independent re-drain (chrome.alarms). The setInterval above keeps the offscreen warm only
// while the SW itself is alive; an SW reap (sleep/memory pressure/reload) kills it AND any
// in-flight drain, leaving freshly-captured NULL chunks un-embedded until the next user action.
// A chrome.alarms alarm survives the SW reap: on fire it RE-CREATES the offscreen (ensureOffscreen)
// and triggers a re-drain via the same ping op, so capture+embed completes even with the side
// panel closed. The alarms minimum period is 1 minute; the setInterval stays as the fast path
// while warm. Registered on BOTH install and startup since the SW is not durable.
// ---------------------------------------------------------------------------

const REDRAIN_ALARM = 'recall-redrain'

function registerRedrainAlarm(): void {
  chrome.alarms?.create(REDRAIN_ALARM, { periodInMinutes: 1 })
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== REDRAIN_ALARM) return
  void (async () => {
    try {
      await ensureOffscreen()
      await callOffscreen({ op: 'ping' })
    } catch (e) {
      console.error('[recall/bg] redrain alarm failed:', e)
    }
  })()
})

// Service Worker: thin relay.
// Receives messages from popup/content, forwards to the offscreen via RPC,
// re-broadcasts progress events to the popup.
// No core services, no store, no embedder here.

import type { Msg, MsgResult } from '../messaging'
import type { RankedResult } from '../core/model'
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

function ensureOffscreen(): Promise<void> {
  if (_offscreenDocP) return _offscreenDocP
  _offscreenDocP = (async () => {
    const exists = await chrome.offscreen?.hasDocument?.()
    if (exists) return
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
      reasons: ['BLOBS'],
      justification: 'OPFS sqlite + WebGPU embedder via offscreen document',
    })
  })()
  return _offscreenDocP
}

function resetOffscreen(): void {
  _offscreenDocP = null
}

installSwRpcListener()
registerOffscreenEnsurer(ensureOffscreen, resetOffscreen)

// ---------------------------------------------------------------------------
// Model status (SW tracks the latest status from rpc-events; popup reads it)
// ---------------------------------------------------------------------------

let modelStatus: ModelStatus = INITIAL_MODEL_STATUS

function broadcastModelStatus(status: ModelStatus): void {
  chrome.runtime.sendMessage({ type: 'model-progress', status }).catch(() => {})
}

function broadcastIndexingProgress(pending: number, embedded: number): void {
  chrome.runtime.sendMessage({ type: 'indexing-progress', pending, embedded }).catch(() => {})
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
    // pending=1 means "still going"; embedded is the running total.
    broadcastIndexingProgress(1, (msg.embedded as number) ?? 0)
  } else if (msg?.kind === 'indexing-complete') {
    // pending=0 signals "done" to the popup UI.
    const total = (msg.totalEmbedded as number) ?? 0
    broadcastIndexingProgress(0, total)
    if (total > 0) {
      modelStatus = { state: 'ready', percent: 100 }
      broadcastModelStatus(modelStatus)
    }
  }

  return false
})

// ---------------------------------------------------------------------------
// Message router: capture / recall / model-status -> offscreen RPC
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === 'model-status') {
    sendResponse({ type: 'model-status', status: modelStatus } satisfies MsgResult)
    return true
  }

  if (msg.type !== 'capture' && msg.type !== 'recall') return false

  ;(async () => {
    try {
      await ensureOffscreen()

      if (msg.type === 'capture') {
        const r = await callOffscreen<{ chunkCount: number }>({
          op: 'capture',
          url: msg.url,
          title: msg.title,
          text: msg.text,
        })
        sendResponse({ type: 'captured', chunkCount: r.chunkCount } satisfies MsgResult)
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
// onInstalled: pre-warm model in offscreen
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log('[recall/bg] onInstalled: pre-warming model in offscreen...')
  ;(async () => {
    await ensureOffscreen()
    const r = await callOffscreen<{ device: string }>({
      op: 'ensureLoaded',
    })
    console.log('[recall/bg] pre-warm complete: device =', r.device)
    modelStatus = { state: 'ready', percent: 100 }
    broadcastModelStatus(modelStatus)
  })().catch((e) => {
    console.error('[recall/bg] pre-warm FAILED:', e)
    modelStatus = { state: 'error', percent: modelStatus.percent }
  })
})

// ---------------------------------------------------------------------------
// Keep-alive: ping the offscreen every 25s so Chrome does not reap it.
// This keeps the model resident across captures.
// ---------------------------------------------------------------------------

setInterval(() => {
  callOffscreen({ op: 'ping' }).catch(() => {})
}, 25_000)


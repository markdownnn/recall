import type { CapturedPage, RankedResult } from './core/model'

export type Msg =
  | { type: 'capture'; url: string; title: string; text: string; manual: boolean }
  | { type: 'capture-text'; url: string; title: string; text: string }
  | { type: 'recall'; text: string; k: number }
  | { type: 'model-status' }
  | { type: 'get-settings' }
  | { type: 'set-paused'; paused: boolean }
  | { type: 'deny-host'; host: string }
  | { type: 'remove-deny-host'; host: string }
  | { type: 'forget-host'; host: string }
  | { type: 'has-page'; url: string }
  | { type: 'page-pending'; url: string }
  | { type: 'recent-pages'; limit: number; beforeTs?: number }

export type MsgResult =
  | { type: 'captured'; captured: boolean; chunkCount: number; reason?: 'paused' | 'denylisted' | 'thin' }
  | { type: 'recalled'; results: RankedResult[] }
  | { type: 'error'; error: string }
  | { type: 'model-status'; status: import('./core/model-progress').ModelStatus }
  | { type: 'settings'; paused: boolean; userDenyHosts: string[] }
  | { type: 'page-status'; exists: boolean }
  | { type: 'page-pending-status'; pending: boolean }
  | { type: 'pages'; pages: CapturedPage[] }
  | { type: 'ok' }

// Push message sent from background to popup (not a request/response pair).
export type ModelProgressMsg = { type: 'model-progress'; status: import('./core/model-progress').ModelStatus }

// Push message sent from background to popup for indexing progress.
// pending = chunks still waiting for a vector; embedded = done so far this drain.
export type IndexingProgressMsg = { type: 'indexing-progress'; pending: number; embedded: number }

// Push message sent from background to popup when an async indexing drain fails
// (e.g. embedding errored). Without this the popup is stuck on "indexing..."
// forever because the drain runs fire-and-forget after capture returns.
export type IndexingErrorMsg = { type: 'indexing-error'; error: string }

// Push message sent from background to the side panel when the on-device embedder is degraded:
// state:'unavailable' = granite failed on BOTH WebGPU and WASM, so search can't work on this
// device; state:'wasm' = granite runs but on slow single-thread WASM. The panel renders a
// persistent banner so the user knows search is broken / slow instead of silently unsearchable.
export type EmbedderDegradedMsg = { type: 'embedder-degraded'; state: 'unavailable' | 'wasm' }

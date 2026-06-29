import type { RankedResult } from './core/model'

export type Msg =
  | { type: 'capture'; url: string; title: string; text: string }
  | { type: 'recall'; text: string; k: number }
  | { type: 'model-status' }

export type MsgResult =
  | { type: 'captured' }
  | { type: 'recalled'; results: RankedResult[] }
  | { type: 'error'; error: string }
  | { type: 'model-status'; status: import('./core/model-progress').ModelStatus }

// Push message sent from background to popup (not a request/response pair).
export type ModelProgressMsg = { type: 'model-progress'; status: import('./core/model-progress').ModelStatus }

import type { RankedResult } from './core/model'

export type Msg =
  | { type: 'capture'; url: string; title: string; text: string }
  | { type: 'recall'; text: string; k: number }

export type MsgResult =
  | { type: 'captured' }
  | { type: 'recalled'; results: RankedResult[] }
  | { type: 'error'; error: string }

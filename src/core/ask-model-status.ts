export type AskModelStatus =
  | { state: 'not-loaded'; percent: 0 }
  | { state: 'loading'; percent: number }
  | { state: 'ready'; percent: 100 }
  | { state: 'error'; percent: number; message: string }

export interface AskModelProgressEvent { status: string; progress?: number; error?: string }

export const INITIAL_ASK_MODEL_STATUS: AskModelStatus = { state: 'not-loaded', percent: 0 }

export function reduceAskModelProgress(prev: AskModelStatus, e: AskModelProgressEvent): AskModelStatus {
  switch (e.status) {
    case 'initiate':
    case 'download':
      return { state: 'loading', percent: prev.percent }
    case 'progress':
      return { state: 'loading', percent: Math.max(prev.percent, Math.round(e.progress ?? prev.percent)) }
    case 'done':
      return { state: 'loading', percent: prev.percent }
    case 'ready':
      return { state: 'ready', percent: 100 }
    case 'error':
      return { state: 'error', percent: prev.percent, message: e.error ?? 'Could not load WebLLM' }
    default:
      return prev
  }
}

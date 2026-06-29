export type ModelState = 'idle' | 'loading' | 'ready' | 'error'
export interface ModelStatus { state: ModelState; percent: number }

export interface ProgressEvent { status: string; progress?: number }

export function reduceModelProgress(prev: ModelStatus, e: ProgressEvent): ModelStatus {
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
    default:
      return prev
  }
}
export const INITIAL_MODEL_STATUS: ModelStatus = { state: 'idle', percent: 0 }

// OffscreenWorkerStore: implements VectorSearchPort by delegating to the
// sqlite-worker (OPFS SAH pool) via postMessage request/reply.
//
// Message format:
//   Request:  { id: number, op: string, args: unknown }
//   Reply OK: { id: number, result: unknown }
//   Reply ER: { id: number, error: string }
//
// Float32Array crosses the worker boundary via structured clone (postMessage),
// which preserves typed arrays in full — no number[] conversion needed.

import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'

// Minimal Worker surface this store needs. Injected via the constructor so unit
// tests can supply a FAKE worker (just postMessage + settable event handlers)
// and exercise reply/timeout/fault handling without a real Worker.
export interface WorkerLike {
  postMessage(msg: unknown): void
  onmessage: ((e: MessageEvent) => void) | null
  onerror: ((e: unknown) => void) | null
  onmessageerror: ((e: MessageEvent) => void) | null
  terminate?(): void
}

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// If the worker crashes or never initialises, a call without a timeout hangs
// forever, which wedges IndexingService.running=true and kills indexing for
// good. 30s is generous for any single OPFS op.
const CALL_TIMEOUT_MS = 30_000

export class OffscreenWorkerStore implements VectorSearchPort {
  private readonly worker: WorkerLike
  private readonly pending = new Map<number, PendingEntry>()
  private nextId = 0

  constructor(worker?: WorkerLike) {
    this.worker =
      worker ??
      (new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' }) as WorkerLike)

    this.worker.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data as { id: number; result?: unknown; error?: string }
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      clearTimeout(entry.timer)
      if (error !== undefined) {
        entry.reject(new Error(error))
      } else {
        entry.resolve(result)
      }
    }

    // A worker fault (crash, failed init, uncaught error) must reject EVERY
    // pending call, otherwise their promises hang forever and indexing stays
    // permanently dead. Same for a structured-clone failure (onmessageerror).
    this.worker.onerror = (e: unknown) => {
      const message = (e as { message?: string })?.message ?? String(e)
      console.error('[offscreen-worker-store] worker error:', message)
      this.rejectAll(new Error(`[offscreen-worker-store] worker error: ${message}`))
    }
    this.worker.onmessageerror = () => {
      console.error('[offscreen-worker-store] worker messageerror (structured clone failed)')
      this.rejectAll(new Error('[offscreen-worker-store] worker messageerror'))
    }
  }

  private rejectAll(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }

  private call<T>(op: string, args: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`[offscreen-worker-store] timeout: op=${op} id=${id} after ${CALL_TIMEOUT_MS}ms`))
        }
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.worker.postMessage({ id, op, args })
    })
  }

  upsertPage(page: CapturedPage): Promise<void> {
    return this.call('upsertPage', { page })
  }

  putChunks(pageId: string, chunks: Chunk[]): Promise<void> {
    return this.call('putChunks', { pageId, chunks })
  }

  pendingChunks(limit: number): Promise<Chunk[]> {
    return this.call<Chunk[]>('pendingChunks', { limit })
  }

  setVector(chunkId: string, vector: Float32Array): Promise<void> {
    // Float32Array is preserved by structured clone — no conversion.
    return this.call('setVector', { chunkId, vector })
  }

  search(queryVector: Float32Array, k: number): Promise<RankedResult[]> {
    // Float32Array is preserved by structured clone — no conversion.
    // The reply is RankedResult[] (plain objects only) — no typed arrays returned.
    return this.call<RankedResult[]>('search', { queryVector, k })
  }
}

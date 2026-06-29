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

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class OffscreenWorkerStore implements VectorSearchPort {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingEntry>()
  private nextId = 0

  constructor() {
    this.worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data as { id: number; result?: unknown; error?: string }
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (error !== undefined) {
        entry.reject(new Error(error))
      } else {
        entry.resolve(result)
      }
    }
    this.worker.onerror = (e) => {
      console.error('[offscreen-worker-store] worker error:', e.message)
    }
  }

  private call<T>(op: string, args: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
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

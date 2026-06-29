import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'
import type { SqliteWorkerClient } from './sqlite-worker-client'

export class WorkerVectorStore implements VectorSearchPort {
  constructor(private readonly c: SqliteWorkerClient) {}
  upsertPage = (p: CapturedPage) => this.c.request<void>('upsertPage', p)
  putChunks = (pageId: string, chunks: Chunk[]) => this.c.request<void>('putChunks', { pageId, chunks })
  pendingChunks = (limit: number) => this.c.request<Chunk[]>('pendingChunks', { limit })
  setVector = (id: string, vector: Float32Array) => this.c.request<void>('setVector', { id, vector })
  search = (query: Float32Array, k: number) => this.c.request<RankedResult[]>('search', { query, k })
}

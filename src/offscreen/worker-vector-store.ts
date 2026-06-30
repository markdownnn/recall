import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'
import type { SqliteWorkerClient } from './sqlite-worker-client'

export class WorkerVectorStore implements VectorSearchPort {
  constructor(private readonly c: SqliteWorkerClient) {}
  upsertPage = (p: CapturedPage) => this.c.request<void>('upsertPage', p)
  putChunks = (pageId: string, chunks: Chunk[]) => this.c.request<void>('putChunks', { pageId, chunks })
  hasPage = (pageId: string) => this.c.request<boolean>('hasPage', pageId)
  pagePending = (pageId: string) => this.c.request<boolean>('pagePending', pageId)
  recentPages = (limit: number, beforeTs?: number) =>
    this.c.request<CapturedPage[]>('recentPages', { limit, beforeTs })
  pendingChunks = (limit: number) => this.c.request<Chunk[]>('pendingChunks', { limit })
  // Declarative embed-queue snapshot for the side panel's mount-time indexing indicator.
  chunkCounts = () => this.c.request<{ pending: number; embedded: number }>('chunkCounts', undefined)
  setVector = (id: string, vector: Float32Array) => this.c.request<void>('setVector', { id, vector })
  clearVectorsForPage = (pageId: string) => this.c.request<void>('clearVectorsForPage', pageId)
  pagesWithVectors = () => this.c.request<string[]>('pagesWithVectors', undefined)
  search = (queryVector: Float32Array, queryText: string, k: number) =>
    this.c.request<RankedResult[]>('search', { queryVector: Array.from(queryVector), queryText, k })
  deletePagesByHost = (host: string) => this.c.request<void>('deletePagesByHost', host)
}

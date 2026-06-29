import type { Chunk, RankedResult } from './model'

export interface ContentChunkerPort {
  chunk(input: { pageId: string; text: string }): Chunk[]
}

export interface EmbeddingPort {
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>
}

export interface VectorSearchPort {
  upsertPage(page: import('./model').CapturedPage): Promise<void>
  // Replace ALL of a page's chunks with these (text only, no vectors yet = pending).
  putChunks(pageId: string, chunks: Chunk[]): Promise<void>
  // Up to `limit` chunks that have no vector yet (the durable embedding queue).
  pendingChunks(limit: number): Promise<Chunk[]>
  // Attach a vector to a chunk, marking it embedded/searchable.
  setVector(chunkId: string, vector: Float32Array): Promise<void>
  // Search ONLY over embedded chunks (those with a vector).
  search(queryVector: Float32Array, k: number): Promise<RankedResult[]>
}

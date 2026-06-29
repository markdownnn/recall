import type { Chunk, RankedResult } from './model'

export interface ContentChunkerPort {
  chunk(input: { pageId: string; text: string }): Chunk[]
}

export interface EmbeddingPort {
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>
}

export interface VectorSearchPort {
  upsertPage(page: import('./model').CapturedPage): Promise<void>
  upsertChunk(chunk: Chunk, vector: Float32Array): Promise<void>
  search(queryVector: Float32Array, k: number): Promise<RankedResult[]>
}

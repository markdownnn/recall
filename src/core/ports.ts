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
  // True if this page id is already stored (drives the panel's SAVED badge).
  hasPage(pageId: string): Promise<boolean>
  // Search ONLY over embedded chunks (those with a vector).
  search(queryVector: Float32Array, queryText: string, k: number): Promise<RankedResult[]>
  // Delete all pages (and their chunks) whose host equals or is a subdomain of the given host.
  deletePagesByHost(host: string): Promise<void>
}

export interface AppSettings {
  paused: boolean
  userDenyHosts: string[]
}

export interface SettingsPort {
  get(): Promise<AppSettings>
  setPaused(paused: boolean): Promise<void>
  addDenyHost(host: string): Promise<void>
  removeDenyHost(host: string): Promise<void>
}

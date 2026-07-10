import type { AnswerRetrievalOptions } from './answer-retrieval'
import type { Chunk, RankedResult } from './model'

// Wraps "turn a page into clean, block-joined prose + a title" behind one seam so the
// extractor (today: Readability 0.6 + DOM pre-clean) can be swapped or A/B'd (e.g. Defuddle)
// without touching the content script or the chunker. Takes a live document (or a clone) and
// returns the chunker's input, or null when the page has no extractable prose.
export interface ExtractionPort {
  extract(doc: Document): { title: string; text: string } | null
}

export interface ContentChunkerPort {
  chunk(input: { pageId: string; text: string }): Chunk[]
}

export interface EmbeddingPort {
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>
}

// A cross-encoder reranker: reads each (query, candidate) PAIR together and reorders the
// candidates by joint relevance, best first, returning the top k. Unlike the bi-encoder
// EmbeddingPort (which encodes query and passage separately and compares vectors), the joint
// read ranks better but costs more, so it only ever scores a small retrieved candidate set.
export interface RerankPort {
  rerank(query: string, candidates: RankedResult[], k: number): Promise<RankedResult[]>
}

export interface VectorSearchPort {
  upsertPage(page: import('./model').CapturedPage): Promise<void>
  // Replace ALL of a page's chunks with these (text only, no vectors yet = pending).
  putChunks(pageId: string, chunks: Chunk[]): Promise<void>
  // Up to `limit` chunks that have no vector yet (the durable embedding queue).
  pendingChunks(limit: number): Promise<Chunk[]>
  // Attach a vector to a chunk, marking it embedded/searchable.
  setVector(chunkId: string, vector: Float32Array): Promise<void>
  // Reset ONE page's chunk vectors to pending (NULL). Used by the model-swap migration to
  // re-embed the corpus a page at a time: after this, pendingChunks() returns this page's
  // chunks and the drain re-embeds them with the loaded model. Every OTHER page keeps its
  // vectors and stays searchable. Page and chunk text are untouched.
  clearVectorsForPage(pageId: string): Promise<void>
  // Page ids that have at least one EMBEDDED (non-NULL) chunk. The model-swap migration uses
  // this to convert ONLY pages that already hold old-model vectors - a page captured mid-init
  // whose chunks are all still NULL is excluded, so the normal drain (which fires the
  // indexing-complete terminal) handles it instead of the migration's reindex-progress path.
  pagesWithVectors(): Promise<string[]>
  // True if this page id is already stored (drives the panel's SAVED badge).
  hasPage(pageId: string): Promise<boolean>
  // True if this page has at least one un-embedded (NULL-vector) chunk still pending. Drives
  // the side panel's PER-PAGE indexing indicator: it lights up only while the CURRENT page is
  // being indexed, so background/migration drains of OTHER pages stay silent.
  pagePending(pageId: string): Promise<boolean>
  // Reverse-chronological browse for the History tab. `beforeTs` is a keyset cursor:
  // omit for the first page, pass the last row's capturedAt for the next page.
  recentPages(limit: number, beforeTs?: number): Promise<import('./model').CapturedPage[]>
  // Search ONLY over embedded chunks (those with a vector).
  search(queryVector: Float32Array, queryText: string, k: number): Promise<RankedResult[]>
  // Ask needs context, not a page list: return multiple useful chunks per matching page,
  // including nearby chunks when configured.
  searchForAnswer(queryVector: Float32Array, queryText: string, options: AnswerRetrievalOptions): Promise<RankedResult[]>
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
  // The embedding-model version last used to embed this profile (null on a fresh DB).
  getEmbedVersion(): Promise<string | null>
  setEmbedVersion(version: string): Promise<void>
}

import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'
import { cosineSimilarity } from '../core/cosine'
import { rrfFuse } from '../core/rrf'
import {
  topPagesBySnippet,
  CANDIDATE_PAGE_LIMIT,
  chooseSnippetChunk,
  SNIPPET_EPSILON,
  SNIPPET_TAU,
  LEXICAL_RRF_WEIGHT,
} from '../core/ranking'

export class MemoryVectorStore implements VectorSearchPort {
  private pages = new Map<string, CapturedPage>()
  private chunks = new Map<string, { chunk: Chunk; vector: Float32Array | null }>()

  async upsertPage(page: CapturedPage): Promise<void> {
    this.pages.set(page.id, page)
  }

  async putChunks(pageId: string, chunks: Chunk[]): Promise<void> {
    // Delete all existing entries for this pageId.
    for (const [id, { chunk }] of this.chunks) {
      if (chunk.pageId === pageId) this.chunks.delete(id)
    }
    // Insert each chunk with no vector yet (pending).
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, { chunk, vector: null })
    }
  }

  async hasPage(pageId: string): Promise<boolean> {
    return this.pages.has(pageId)
  }

  async recentPages(limit: number, beforeTs?: number): Promise<CapturedPage[]> {
    return [...this.pages.values()]
      .filter((p) => beforeTs === undefined || p.capturedAt < beforeTs)
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, limit)
  }

  async pendingChunks(limit: number): Promise<Chunk[]> {
    const result: Chunk[] = []
    for (const { chunk, vector } of this.chunks.values()) {
      if (vector === null) {
        result.push(chunk)
        if (result.length >= limit) break
      }
    }
    return result
  }

  // Declarative embed-queue snapshot (mirrors WorkerVectorStore.chunkCounts for parity/tests).
  async chunkCounts(): Promise<{ pending: number; embedded: number }> {
    let pending = 0
    let embedded = 0
    for (const { vector } of this.chunks.values()) {
      if (vector === null) pending++
      else embedded++
    }
    return { pending, embedded }
  }

  async setVector(chunkId: string, vector: Float32Array): Promise<void> {
    const entry = this.chunks.get(chunkId)
    if (entry) entry.vector = vector
  }

  async clearVectorsForPage(pageId: string): Promise<void> {
    for (const entry of this.chunks.values()) {
      if (entry.chunk.pageId === pageId) entry.vector = null
    }
  }

  async pagesWithVectors(): Promise<string[]> {
    const ids = new Set<string>()
    for (const { chunk, vector } of this.chunks.values()) {
      if (vector !== null) ids.add(chunk.pageId)
    }
    return [...ids]
  }

  async search(queryVector: Float32Array, queryText: string, k: number): Promise<RankedResult[]> {
    // 1. Vector lane (PAGE-DIVERSE): cosine over all embedded chunks, reduced to the single
    //    best-cosine chunk PER pageId, then sorted by cosine desc and capped to N DISTINCT
    //    PAGES. Capping pages (not chunks) stops one busy page with >N high-scoring chunks
    //    from monopolizing the lane and collapsing the result to a single document.
    //    Fix 3: collect ALL of a page's chunks (not just the max-cosine one) so the snippet
    //    chooser can swap a citation-list winner for a near-tie prose chunk; the page's RANK
    //    score stays the max cosine, so the lane ordering is unchanged.
    const vecByPage = new Map<string, { id: string; cos: number; text: string }[]>()
    for (const { chunk, vector } of this.chunks.values()) {
      if (vector === null) continue // pending chunks are not searchable
      const page = this.pages.get(chunk.pageId)
      if (!page) continue
      const cos = cosineSimilarity(queryVector, vector)
      const arr = vecByPage.get(chunk.pageId) ?? []
      arr.push({ id: chunk.id, cos, text: chunk.text })
      vecByPage.set(chunk.pageId, arr)
    }
    const vectorIds = [...vecByPage.values()]
      .map((cands) => chooseSnippetChunk(cands, SNIPPET_EPSILON, SNIPPET_TAU))
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATE_PAGE_LIMIT)
      .map((x) => x.id)

    // 2. Lexical lane (PAGE-DIVERSE): chunks whose lowercased text contains any query term
    //    of length >= 3, ordered by number of distinct terms matched (desc); keep the FIRST
    //    (best) chunk per pageId, capped to N DISTINCT PAGES.
    const queryTerms = queryText
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => [...t].length >= 3)
    const lexicalIds: string[] = []
    if (queryTerms.length > 0) {
      const matched: { id: string; pageId: string; count: number }[] = []
      for (const { chunk, vector } of this.chunks.values()) {
        if (vector === null) continue
        const lower = chunk.text.toLowerCase()
        const count = queryTerms.reduce((n, term) => n + (lower.includes(term.toLowerCase()) ? 1 : 0), 0)
        if (count > 0) matched.push({ id: chunk.id, pageId: chunk.pageId, count })
      }
      matched.sort((a, b) => b.count - a.count)
      const seenPages = new Set<string>()
      for (const m of matched) {
        if (seenPages.has(m.pageId)) continue
        seenPages.add(m.pageId)
        lexicalIds.push(m.id)
        if (lexicalIds.length >= CANDIDATE_PAGE_LIMIT) break
      }
    }

    // 3. Fuse both rankings with RRF over the FULL list (no slice), hydrate every fused
    //    id to a RankedResult, then collapse to top-k PAGES (best chunk per page).
    const fused = rrfFuse([vectorIds, lexicalIds], 60, [1, LEXICAL_RRF_WEIGHT])
    const chunkById = new Map(
      [...this.chunks.values()].map(({ chunk, vector }) => [chunk.id, { chunk, vector }]),
    )
    const results: RankedResult[] = []
    for (const hit of fused) {
      const entry = chunkById.get(hit.id)
      if (!entry) continue
      const page = this.pages.get(entry.chunk.pageId)
      if (!page) continue
      results.push({ chunk: entry.chunk, page, score: hit.score })
    }
    return topPagesBySnippet(results, k)
  }

  async deletePagesByHost(host: string): Promise<void> {
    const pageIds: string[] = []
    for (const [id, page] of this.pages) {
      let h = ''
      try { h = new URL(page.url).hostname.toLowerCase() } catch {}
      if (h === host || h.endsWith('.' + host)) { pageIds.push(id); this.pages.delete(id) }
    }
    for (const [id, { chunk }] of this.chunks) {
      if (pageIds.includes(chunk.pageId)) this.chunks.delete(id)
    }
  }
}

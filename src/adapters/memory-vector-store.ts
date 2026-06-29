import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'
import { cosineSimilarity } from '../core/cosine'

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

  async setVector(chunkId: string, vector: Float32Array): Promise<void> {
    const entry = this.chunks.get(chunkId)
    if (entry) entry.vector = vector
  }

  async search(queryVector: Float32Array, k: number): Promise<RankedResult[]> {
    const scored: RankedResult[] = []
    for (const { chunk, vector } of this.chunks.values()) {
      if (vector === null) continue // pending chunks are not searchable
      const page = this.pages.get(chunk.pageId)
      if (!page) continue
      scored.push({ chunk, page, score: cosineSimilarity(queryVector, vector) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
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

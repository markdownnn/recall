import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'

function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

export class MemoryVectorStore implements VectorSearchPort {
  private pages = new Map<string, CapturedPage>()
  private chunks = new Map<string, { chunk: Chunk; vector: Float32Array }>()

  async upsertPage(page: CapturedPage): Promise<void> {
    this.pages.set(page.id, page)
  }

  async upsertChunk(chunk: Chunk, vector: Float32Array): Promise<void> {
    this.chunks.set(chunk.id, { chunk, vector })
  }

  async search(queryVector: Float32Array, k: number): Promise<RankedResult[]> {
    const scored: RankedResult[] = []
    for (const { chunk, vector } of this.chunks.values()) {
      const page = this.pages.get(chunk.pageId)
      if (!page) continue
      scored.push({ chunk, page, score: dotProduct(queryVector, vector) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }
}

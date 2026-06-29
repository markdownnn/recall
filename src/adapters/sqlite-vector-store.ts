import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'
import { cosineSimilarity } from '../core/cosine'

// Minimal sqlite-wasm DB handle interface (injected for testability).
export interface SqliteDb {
  exec(opts: { sql: string; bind?: unknown[]; rowMode?: string; callback?: (row: any) => void }): void
}

export class SqliteVectorStore implements VectorSearchPort {
  constructor(private readonly db: SqliteDb) {
    this.db.exec({ sql: `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, url TEXT, title TEXT, capturedAt INTEGER)` })
    this.db.exec({ sql: `CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, pageId TEXT, idx INTEGER, text TEXT, vector BLOB)` })
  }

  async upsertPage(page: CapturedPage): Promise<void> {
    this.db.exec({
      sql: `INSERT OR REPLACE INTO pages (id, url, title, capturedAt) VALUES (?, ?, ?, ?)`,
      bind: [page.id, page.url, page.title, page.capturedAt],
    })
  }

  async upsertChunk(chunk: Chunk, vector: Float32Array): Promise<void> {
    this.db.exec({
      sql: `INSERT OR REPLACE INTO chunks (id, pageId, idx, text, vector) VALUES (?, ?, ?, ?, ?)`,
      bind: [chunk.id, chunk.pageId, chunk.index, chunk.text, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)],
    })
  }

  async clearChunks(pageId: string): Promise<void> {
    this.db.exec({ sql: 'DELETE FROM chunks WHERE pageId = ?', bind: [pageId] })
  }

  async search(queryVector: Float32Array, k: number): Promise<RankedResult[]> {
    const pages = new Map<string, CapturedPage>()
    this.db.exec({
      sql: `SELECT id, url, title, capturedAt FROM pages`,
      rowMode: 'object',
      callback: (r: any) => pages.set(r.id, { id: r.id, url: r.url, title: r.title, capturedAt: r.capturedAt }),
    })
    const scored: RankedResult[] = []
    this.db.exec({
      sql: `SELECT id, pageId, idx, text, vector FROM chunks`,
      rowMode: 'object',
      callback: (r: any) => {
        const page = pages.get(r.pageId)
        if (!page) return
        const bytes = r.vector as Uint8Array
        const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
        const vector = new Float32Array(f32) // copy so it is standalone
        const chunk: Chunk = { id: r.id, pageId: r.pageId, index: r.idx, text: r.text }
        scored.push({ chunk, page, score: cosineSimilarity(queryVector, vector) })
      },
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }
}

// Real sqlite worker: owns the OPFS SAH pool DB for the recall extension.
// Handles request messages { id, op, args } and replies { id, result } or { id, error }.
// Declarative SCHEMA array + op->handler MAP. Adding an op = adding a row to the map.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { cosineSimilarity } from '../core/cosine'
import { rrfFuse } from '../core/rrf'
import { toFtsQuery } from '../core/fts-query'
import { topPagesBySnippet, CANDIDATE_PAGE_LIMIT } from '../core/ranking'

import type { CapturedPage, Chunk, RankedResult } from '../core/model'
import type { AppSettings } from '../core/ports'

// Set true only after the FTS5 table + triggers are successfully created (see init).
// A broken FTS must NOT disable capture/recall, so opSearch falls back to vector-only
// when this stays false.
let ftsAvailable = false

// ---------------------------------------------------------------------------
// Schema — applied in order on startup
// ---------------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, url TEXT, title TEXT, capturedAt INTEGER, host TEXT)`,
  `CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, pageId TEXT, idx INTEGER, text TEXT, vector BLOB NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS user_denylist (host TEXT PRIMARY KEY)`,
]

// ---------------------------------------------------------------------------
// Handler functions (existing ops — behavior unchanged)
// ---------------------------------------------------------------------------

function opUpsertPage(db: any, page: CapturedPage): void {
  let host = ''
  try { host = new URL(page.url).hostname.toLowerCase() } catch {}
  db.exec({
    sql: `INSERT OR REPLACE INTO pages (id, url, title, capturedAt, host) VALUES (?, ?, ?, ?, ?)`,
    bind: [page.id, page.url, page.title, page.capturedAt, host],
  })
}

function opPutChunks(db: any, { pageId, chunks }: { pageId: string; chunks: Chunk[] }): void {
  db.exec({ sql: 'DELETE FROM chunks WHERE pageId = ?', bind: [pageId] })
  for (const chunk of chunks) {
    db.exec({
      sql: `INSERT INTO chunks (id, pageId, idx, text, vector) VALUES (?, ?, ?, ?, NULL)`,
      bind: [chunk.id, chunk.pageId, chunk.index, chunk.text],
    })
  }
}

function opPendingChunks(db: any, { limit }: { limit: number }): Chunk[] {
  const result: Chunk[] = []
  db.exec({
    sql: `SELECT id, pageId, idx, text FROM chunks WHERE vector IS NULL LIMIT ?`,
    bind: [limit],
    rowMode: 'object',
    callback: (r: any) => result.push({ id: r.id, pageId: r.pageId, index: r.idx, text: r.text }),
  })
  return result
}

function opSetVector(db: any, { id, vector }: { id: string; vector: Float32Array }): void {
  // vector arrives via structured clone — it is a real Float32Array.
  // Store the raw bytes as BLOB so we can reconstruct it on search.
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
  db.exec({
    sql: 'UPDATE chunks SET vector = ? WHERE id = ?',
    bind: [bytes, id],
  })
}

// Hydrate a fused id into a RankedResult: load the chunk + its page, attach the score.
// Returns null when the chunk or its page no longer exists (skipped by the caller).
function hydrate(db: any, chunkId: string, score: number): RankedResult | null {
  let chunk: Chunk | null = null
  let pageId = ''
  db.exec({
    sql: `SELECT id, pageId, idx, text FROM chunks WHERE id = ?`,
    bind: [chunkId],
    rowMode: 'object',
    callback: (r: any) => {
      chunk = { id: r.id, pageId: r.pageId, index: r.idx, text: r.text }
      pageId = r.pageId
    },
  })
  if (!chunk) return null
  let page: CapturedPage | null = null
  db.exec({
    sql: `SELECT id, url, title, capturedAt FROM pages WHERE id = ?`,
    bind: [pageId],
    rowMode: 'object',
    callback: (r: any) => { page = { id: r.id, url: r.url, title: r.title, capturedAt: r.capturedAt } },
  })
  if (!page) return null
  return { chunk, page, score }
}

function opSearch(db: any, { queryVector, queryText, k }: { queryVector: number[]; queryText: string; k: number }): RankedResult[] {
  const N = CANDIDATE_PAGE_LIMIT
  // Pull this many bm25-ordered FTS rows before deduping to N pages in JS: enough headroom
  // that even a busy page contributing many top rows still leaves room for N distinct pages.
  const LEXICAL_SCAN_LIMIT = 300
  const q = Float32Array.from(queryVector)

  // 1. Vector candidates (PAGE-DIVERSE): cosine over embedded chunks, reduced to the best-
  //    cosine chunk PER pageId, sorted by cosine desc, capped to N DISTINCT PAGES. Capping
  //    pages (not chunks) stops one busy page with >N high-scoring chunks from monopolizing
  //    the lane and collapsing the result to a single document.
  //    Reuse the shared cosineSimilarity (NOT a hand-rolled dot product, which would
  //    silently assume normalize:true and diverge from the core/memory-store ranking).
  const vecBestByPage = new Map<string, { id: string; cos: number }>()
  db.exec({
    sql: `SELECT c.id AS id, c.pageId AS pageId, c.vector AS vector FROM chunks c WHERE c.vector IS NOT NULL`,
    rowMode: 'object',
    callback: (r: any) => {
      const bytes = r.vector as Uint8Array
      const v = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      const cos = cosineSimilarity(q, v)
      const cur = vecBestByPage.get(r.pageId)
      if (!cur || cos > cur.cos) vecBestByPage.set(r.pageId, { id: r.id, cos })
    },
  })
  const vectorIds = [...vecBestByPage.values()]
    .sort((a, b) => b.cos - a.cos)
    .slice(0, N)
    .map((x) => x.id)

  // 2. Lexical candidates (PAGE-DIVERSE): FTS5 trigram BM25, deduped to the first (best)
  //    chunk per pageId, capped to N DISTINCT PAGES. Skipped entirely when the FTS failed
  //    to initialize (ftsAvailable=false) -> graceful vector-only fallback.
  //    MATCH/bm25 must name the real table `chunks_fts`, NOT the alias `f` (verified).
  const lexicalIds: string[] = []
  const match = ftsAvailable ? toFtsQuery(queryText) : null
  if (match) {
    try {
      const rows: { id: string; pageId: string }[] = []
      db.exec({
        sql: `SELECT c.id AS id, c.pageId AS pageId FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
              WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`,
        bind: [match, LEXICAL_SCAN_LIMIT],
        rowMode: 'object',
        callback: (r: any) => rows.push({ id: r.id, pageId: r.pageId }),
      })
      const seenPages = new Set<string>()
      for (const row of rows) {
        if (seenPages.has(row.pageId)) continue
        seenPages.add(row.pageId)
        lexicalIds.push(row.id)
        if (lexicalIds.length >= N) break
      }
    } catch (e) {
      // Malformed match (defensive) -> vector-only this query.
      console.warn('[recall-worker] FTS MATCH failed, vector-only this query:', String(e))
    }
  }

  // 3. Fuse the FULL list (no slice), hydrate every fused id, then collapse to k PAGES.
  const fused = rrfFuse([vectorIds, lexicalIds]) // full ranking; bounded by the N=50 candidate caps
  const hydrated = fused.map((hit) => hydrate(db, hit.id, hit.score)).filter(Boolean) as RankedResult[]
  return topPagesBySnippet(hydrated, k)
}

function opGetSettings(db: any): AppSettings {
  let paused = false
  db.exec({
    sql: `SELECT value FROM settings WHERE key='paused'`,
    rowMode: 'array',
    callback: (r: any) => { paused = r[0] === '1' },
  })
  const userDenyHosts: string[] = []
  db.exec({
    sql: `SELECT host FROM user_denylist`,
    rowMode: 'array',
    callback: (r: any) => userDenyHosts.push(r[0]),
  })
  return { paused, userDenyHosts }
}

function opSetPaused(db: any, paused: boolean): void {
  db.exec({
    sql: `INSERT OR REPLACE INTO settings (key, value) VALUES ('paused', ?)`,
    bind: [paused ? '1' : '0'],
  })
}

function opAddDenyHost(db: any, host: string): void {
  db.exec({
    sql: `INSERT OR IGNORE INTO user_denylist (host) VALUES (?)`,
    bind: [host],
  })
}

function opRemoveDenyHost(db: any, host: string): void {
  db.exec({ sql: `DELETE FROM user_denylist WHERE host = ?`, bind: [host] })
}

function opDeletePagesByHost(db: any, host: string): void {
  const esc = host.replace(/[\\%_]/g, '\\$&')
  const where = `(host = ? OR host LIKE '%.' || ? ESCAPE '\\')`
  db.exec('BEGIN')
  try {
    db.exec({ sql: `DELETE FROM chunks WHERE pageId IN (SELECT id FROM pages WHERE ${where})`, bind: [host, esc] })
    db.exec({ sql: `DELETE FROM pages WHERE ${where}`, bind: [host, esc] })
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

// ---------------------------------------------------------------------------
// Op -> handler MAP (declarative)
// ---------------------------------------------------------------------------

const handlers: Record<string, (db: any, args: any) => unknown> = {
  upsertPage: (db, args) => { opUpsertPage(db, args as CapturedPage) },
  putChunks: (db, args) => { opPutChunks(db, args) },
  pendingChunks: (db, args) => opPendingChunks(db, args),
  setVector: (db, args) => { opSetVector(db, args) },
  search: (db, args) => opSearch(db, args),
  getSettings: (db) => opGetSettings(db),
  setPaused: (db, args) => { opSetPaused(db, args as boolean) },
  addDenyHost: (db, args) => { opAddDenyHost(db, args as string) },
  removeDenyHost: (db, args) => { opRemoveDenyHost(db, args as string) },
  deletePagesByHost: (db, args) => { opDeletePagesByHost(db, args as string) },
}

// ---------------------------------------------------------------------------
// Init: OPFS SAH pool (unchanged)
// ---------------------------------------------------------------------------

let db: any = null

const initPromise: Promise<void> = (async () => {
  try {
    const sqlite3 = await sqlite3InitModule()
    const poolUtil = await (sqlite3 as any).installOpfsSAHPoolVfs({ name: 'recall-pool' })
    db = new poolUtil.OpfsSAHPoolDb('/recall.sqlite3')
    for (const sql of SCHEMA) {
      db.exec({ sql })
    }
    // Idempotent migration: add host column if not already present.
    try { db.exec(`ALTER TABLE pages ADD COLUMN host TEXT`) }
    catch (e) { if (!String(e).toLowerCase().includes('duplicate column')) throw e }
    // Backfill host for existing rows that predate the column.
    const toFix: { id: string; url: string }[] = []
    db.exec({ sql: `SELECT id, url FROM pages WHERE host IS NULL`, rowMode: 'object', callback: (r: any) => toFix.push({ id: r.id, url: r.url }) })
    for (const r of toFix) {
      let host = ''
      try { host = new URL(r.url).hostname.toLowerCase() } catch { /* leave '' */ }
      db.exec({ sql: `UPDATE pages SET host = ? WHERE id = ?`, bind: [host, r.id] })
    }
    if (toFix.length > 0) console.log(`[recall-worker] backfilled host for ${toFix.length} rows`)

    // FTS5 trigram index for the lexical side of hybrid search. Kept in sync with
    // `chunks` via triggers (text is immutable after insert, so only insert/delete
    // triggers are needed). ISOLATED in its own try/catch: a broken FTS must NOT reject
    // initPromise (every op awaits it — a reject would stop CAPTURE too, not just
    // search). On failure we log and leave ftsAvailable=false; opSearch then falls back
    // to vector-only. Do NOT set trusted_schema=0: triggers writing to a virtual table
    // need the build default trusted_schema=ON.
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, content='chunks', content_rowid='rowid', tokenize='trigram'
      )`)
      db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END`)
      db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      END`)
      ftsAvailable = true
      console.log('[recall-worker] FTS5 trigram index ready')
    } catch (e) {
      console.error('[recall-worker] FTS5 init FAILED, lexical search disabled (capture/recall unaffected):', String(e))
    }

    console.log('[recall-worker] sqlite OPFS SAH pool ready, schema created')
  } catch (e) {
    console.error('[recall-worker] init FAILED:', String(e))
    throw new Error(String(e))
  }
})()

// Deferred one-time FTS backfill for upgraded profiles. The `rebuild` tokenizes every
// chunk synchronously and can block the worker for seconds on a heavy profile, so it
// runs AFTER initPromise resolves (never awaited inside init) — the first capture/recall
// is not blocked. New captures index via the triggers regardless of this backfill. The
// gate (ftsCount===0 && chunkCount>0) only self-heals a fully-empty FTS, not a partial.
initPromise
  .then(() => {
    if (!ftsAvailable || !db) return
    try {
      let ftsCount = 0, chunkCount = 0
      db.exec({ sql: `SELECT count(*) FROM chunks_fts`, rowMode: 'array', callback: (r: any) => { ftsCount = r[0] } })
      db.exec({ sql: `SELECT count(*) FROM chunks`, rowMode: 'array', callback: (r: any) => { chunkCount = r[0] } })
      if (ftsCount === 0 && chunkCount > 0) {
        console.log(`[recall-worker] FTS backfill: rebuilding index for ${chunkCount} chunks...`)
        db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`)
        console.log('[recall-worker] FTS backfill: rebuild complete')
      }
    } catch (e) {
      console.error('[recall-worker] FTS backfill failed (lexical may be incomplete):', String(e))
    }
  })
  .catch(() => { /* init rejection already logged; nothing to backfill */ })

// ---------------------------------------------------------------------------
// Message handler (declarative dispatch)
// ---------------------------------------------------------------------------

;(self as DedicatedWorkerGlobalScope).onmessage = async (e: MessageEvent) => {
  const { id, op, args } = e.data as { id: number; op: string; args: any }
  try {
    await initPromise
    const handler = handlers[op]
    if (!handler) throw new Error(`[recall-worker] unknown op: ${op}`)
    const result = handler(db, args)
    ;(self as DedicatedWorkerGlobalScope).postMessage({ id, result })
  } catch (err) {
    ;(self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) })
  }
}

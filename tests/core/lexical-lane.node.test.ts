// REAL lexical-lane test: drives the production SQLite FTS5 trigram + bm25 path.
//
// WHY THIS EXISTS (oracle-vs-prod divergence):
//   The golden-set eval harness and the MemoryVectorStore unit tests use an ORACLE lexical
//   lane: lowercase substring `.includes()` matching, ranked by the COUNT OF DISTINCT QUERY
//   TERMS a chunk matches (see src/adapters/memory-vector-store.ts, "Lexical lane"). Production
//   does NOT use that. Production (src/offscreen/sqlite-worker.ts opSearch) ranks lexical
//   candidates with SQLite FTS5's trigram tokenizer ordered by bm25(). bm25 is a different
//   algorithm (term frequency x inverse document frequency, with DOCUMENT-LENGTH normalization),
//   so the production lexical RANKING is otherwise untested. This file closes that gap.
//
// WHAT IT DRIVES vs. WHAT IT REPLICATES (no overclaiming parity):
//   - REAL: the actual `@sqlite.org/sqlite-wasm` engine, the real `trigram` FTS5 tokenizer, the
//     real `bm25()` ranking function, and the REAL production query builder `toFtsQuery`.
//   - REPLICATED (copied, not imported): the FTS schema (chunks + chunks_fts trigram + insert
//     trigger) and the exact bm25 MATCH query string, both lifted verbatim from sqlite-worker.ts.
//     We cannot import opSearch directly: sqlite-worker.ts initializes an OPFS SAH pool and reads
//     worker-only globals at module load, which cannot run under node/vitest. So this asserts the
//     production lexical ALGORITHM, not the literal opSearch function wiring. If the schema/query
//     in sqlite-worker.ts changes, update the copies below.
//
// ASCII-only: all fixture text is ASCII. The trigram tokenizer is script-agnostic; CJK trigram
// matching is exercised by the e2e suite, not here.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { toFtsQuery } from '../../src/core/fts-query'

// --- Production schema, copied verbatim from src/offscreen/sqlite-worker.ts ------------------
const CHUNKS_TABLE = `CREATE TABLE chunks (id TEXT PRIMARY KEY, pageId TEXT, idx INTEGER, text TEXT, vector BLOB NULL)`
const FTS_TABLE = `CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='trigram')`
const FTS_INSERT_TRIGGER = `CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END`
// Exact production lexical query (sqlite-worker.ts opSearch).
const LEXICAL_QUERY = `SELECT c.id AS id, c.pageId AS pageId FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
  WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`
const LEXICAL_SCAN_LIMIT = 300

async function newDb() {
  // sqlite-wasm expects a browser/worker global `self`; node has none. Shim it, then feed the
  // wasm bytes directly (node's fetch cannot load the package's file:// wasm URL).
  ;(globalThis as any).self = globalThis
  const wasmBinary = readFileSync(
    resolve('node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm'),
  )
  const mod: any = await import('@sqlite.org/sqlite-wasm')
  const sqlite3: any = await mod.default({ wasmBinary })
  const db = new sqlite3.oo1.DB(':memory:')
  db.exec(CHUNKS_TABLE)
  db.exec(FTS_TABLE)
  db.exec(FTS_INSERT_TRIGGER)
  return db
}

function insertChunk(db: any, id: string, pageId: string, idx: number, text: string) {
  db.exec({
    sql: `INSERT INTO chunks (id, pageId, idx, text) VALUES (?, ?, ?, ?)`,
    bind: [id, pageId, idx, text],
  })
}

// Run the production lexical lane: real toFtsQuery -> real bm25 MATCH -> dedup to first chunk
// per page (exactly as opSearch does). Returns the ordered list of distinct pageIds.
function lexicalPages(db: any, queryText: string): string[] {
  const match = toFtsQuery(queryText)
  if (!match) return []
  const rows: { id: string; pageId: string }[] = []
  db.exec({
    sql: LEXICAL_QUERY,
    bind: [match, LEXICAL_SCAN_LIMIT],
    rowMode: 'object',
    callback: (r: any) => rows.push({ id: r.id, pageId: r.pageId }),
  })
  const seen = new Set<string>()
  const pages: string[] = []
  for (const row of rows) {
    if (seen.has(row.pageId)) continue
    seen.add(row.pageId)
    pages.push(row.pageId)
  }
  return pages
}

// Scenario: a recall query must surface the page whose text actually contains the query terms.
// This drives the REAL trigram tokenizer + bm25 + toFtsQuery end to end - the production lexical
// algorithm the oracle never exercises.
// Coverage: integration (real sqlite-wasm FTS5 bm25; production schema + query replicated).
test('real bm25: the page matching both query terms ranks above an unrelated page', async () => {
  const db = await newDb()
  insertChunk(db, 'c1', 'relevant', 0, 'cortisol disrupts REM sleep and raises stress')
  insertChunk(db, 'c2', 'unrelated', 0, 'basics of tax accounting and ledger entries')
  const pages = lexicalPages(db, 'cortisol sleep')
  expect(pages[0]).toBe('relevant')
})

// Scenario: trigram FTS matches SUBSTRINGS (any 3-char run), not whole word tokens - the same
// reason toFtsQuery drops <3-char terms. A 3-char query term must match inside a longer word.
// This documents WHY production uses the trigram tokenizer and the >=3 length filter.
// Coverage: integration (real trigram tokenizer).
test('real trigram: a 3-char term matches a substring inside a longer word', async () => {
  const db = await newDb()
  insertChunk(db, 'c1', 'p1', 0, 'the scorpion crossed the sand')
  const pages = lexicalPages(db, 'cor') // "cor" is a substring of "scorpion"
  expect(pages).toContain('p1')
})

// Scenario (DOCUMENTED ORACLE-VS-PROD DIVERGENCE): two pages each match the SAME set of query
// terms exactly once, differing only in length. The memory-store oracle ranks by COUNT OF
// DISTINCT TERMS matched - here both score 2, so the oracle treats them as a TIE (it has no
// length signal). Production bm25 applies DOCUMENT-LENGTH normalization, so it ranks the SHORTER
// page first. This is a real ordering the golden-set eval can never observe, proving the two
// lexical lanes are NOT equivalent. (Asserted behavior was first observed empirically, not
// assumed.)
// Coverage: integration (real bm25 length normalization).
test('real bm25 length-norm: shorter page ranks above longer page on equal term matches', async () => {
  const db = await newDb()
  const filler = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(' ')
  insertChunk(db, 'cs', 'short', 0, 'cortisol sleep')
  insertChunk(db, 'cl', 'long', 0, `cortisol sleep ${filler}`)
  const pages = lexicalPages(db, 'cortisol sleep')
  // Both pages match both terms; bm25's length normalization breaks the tie toward 'short'.
  // The substring-distinct-count oracle would tie them (both distinct-count = 2).
  expect(pages).toEqual(['short', 'long'])
})

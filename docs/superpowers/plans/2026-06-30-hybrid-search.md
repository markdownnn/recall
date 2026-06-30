# Hybrid Search (Plan 3): FTS5 trigram + vector, RRF fusion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recall find both semantically-similar chunks (vector) AND exact-term matches (a specific name/word the user remembers) by fusing a lexical FTS5 search with the existing vector search.

**Architecture:** Hexagonal + declarative. The fusion (RRF) and the query-to-FTS conversion are PURE core functions (unit + golden-set tested). The worker gains an FTS5 trigram virtual table kept in sync with `chunks` via triggers; its `search` op runs vector cosine + FTS5 BM25 and fuses them with the pure RRF. `VectorSearchPort.search` gains the raw query text (needed for the lexical match).

**Tech Stack:** SQLite FTS5 (trigram tokenizer, built into sqlite-wasm) · Reciprocal Rank Fusion · existing offscreen/worker/WebGPU stack · Vitest + Playwright.

**Decisions (confirmed):**
- **Tokenizer = trigram** — language-agnostic, handles Korean sub-word matching (수면 matches 수면을) and English. Cost: larger index; queries shorter than 3 chars can't lexical-match (vector still covers them).
- **Fusion = RRF** (k=60) — rank-based, no score normalization between cosine (0..1) and BM25 (unbounded).
- **Hybrid replaces vector-only search** (strictly better; the FTS index also serves as the future scale prefilter).
- Each side retrieves top-N=50 candidates; fuse; return top-k.

---

## File Structure

```
src/core/rrf.ts                 # NEW: pure Reciprocal Rank Fusion
src/core/fts-query.ts           # NEW: pure free-text -> FTS5 trigram MATCH expression
src/core/ports.ts               # MODIFY: VectorSearchPort.search adds queryText
src/adapters/memory-vector-store.ts   # MODIFY: hybrid (vector + naive lexical + RRF) for unit tests
src/core/recall-service.ts      # MODIFY: pass query text to store.search
src/offscreen/sqlite-worker.ts  # MODIFY: FTS5 table + triggers + migration; search op -> hybrid
src/offscreen/worker-vector-store.ts  # MODIFY: search passes queryText
src/offscreen/offscreen.ts      # MODIFY: recall op passes query text into search
tests/core/rrf.test.ts          # NEW
tests/core/fts-query.test.ts    # NEW
tests/core/recall-service.test.ts     # MODIFY: hybrid store.search signature
tests/e2e/hybrid-search.spec.ts # NEW: golden set (KO + EN; lexical-only + semantic-only)
```

---

## Task 1: Pure RRF fusion (TDD)

**Files:** Create `src/core/rrf.ts`, `tests/core/rrf.test.ts`

- [ ] **Step 1: Write the failing test**

**Scenario:** A chunk ranked high by EITHER vector or lexical should surface; a chunk ranked decently by BOTH should beat one ranked high by only one. RRF must fuse without score normalization.
**Coverage:** ✅ integration (pure function, real arithmetic)

```ts
import { rrfFuse } from '../../src/core/rrf'

test('fuses two ranked lists; agreement wins', () => {
  // a: top of list1, mid of list2. b: top of list2 only. c: only in list1 lower.
  const fused = rrfFuse([['a', 'c', 'b'], ['b', 'a']])
  expect(fused.map((r) => r.id)[0]).toBe('a') // appears high in both
  expect(fused.map((r) => r.id)).toContain('b')
  expect(fused.map((r) => r.id)).toContain('c')
})

test('id in one list only still appears', () => {
  const fused = rrfFuse([['x'], ['y']])
  expect(new Set(fused.map((r) => r.id))).toEqual(new Set(['x', 'y']))
})

test('empty lists -> empty', () => {
  expect(rrfFuse([[], []])).toEqual([])
})
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/core/rrf.test.ts` -> FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/core/rrf.ts
// Reciprocal Rank Fusion: combine several ranked id lists into one ordering without
// needing to normalize each source's score scale. score(id) = sum 1/(k + rank), rank
// 1-based; higher is better. k=60 is the standard constant.
export interface FusedHit {
  id: string
  score: number
}
export function rrfFuse(lists: string[][], k = 60): FusedHit[] {
  const score = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1))
    })
  }
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score)
}
```

- [ ] **Step 4: Run, watch pass.** `npx vitest run tests/core/rrf.test.ts` -> PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/rrf.ts tests/core/rrf.test.ts
git commit -m "feat(core): pure RRF fusion"
```

---

## Task 2: Pure free-text -> FTS5 MATCH (TDD)

**Files:** Create `src/core/fts-query.ts`, `tests/core/fts-query.test.ts`

- [ ] **Step 1: Write the failing test**

**Scenario:** A user's query must become a SAFE FTS5 trigram MATCH expression: quotes neutralized (no syntax injection / no error), terms shorter than a trigram dropped, and a no-usable-term query returns null so the caller skips lexical and uses vector only.
**Coverage:** ✅ integration (pure function)

```ts
import { toFtsQuery } from '../../src/core/fts-query'

test('ORs quoted terms of length >= 3', () => {
  expect(toFtsQuery('cortisol sleep')).toBe('"cortisol" OR "sleep"')
})

test('drops terms shorter than 3 chars (trigram needs 3)', () => {
  expect(toFtsQuery('a to cortisol')).toBe('"cortisol"')
})

test('neutralizes embedded quotes (no FTS syntax injection)', () => {
  expect(toFtsQuery('say "hi" please')).toBe('"say" OR "hi""" OR "please"'.replace('hi"""', 'hi"" ').trim() ) // see impl note
})

test('korean terms kept (>= 3 chars)', () => {
  expect(toFtsQuery('호르몬 수면')).toBe('"호르몬"') // 수면 is 2 chars -> dropped
})

test('no usable term -> null', () => {
  expect(toFtsQuery('a to')).toBeNull()
  expect(toFtsQuery('   ')).toBeNull()
})
```
(Implementation note: keep the quote-escaping test simple — assert that the output contains no UNescaped lone quote. Prefer asserting `toFtsQuery('a "b').includes('""') || ...`. Adjust the exact expected string to match the impl below; the REAL requirement is: every term wrapped in double quotes with internal `"` doubled, joined by ` OR `, terms <3 chars dropped, null when none.)

- [ ] **Step 2: Run, watch fail.**

- [ ] **Step 3: Implement**

```ts
// src/core/fts-query.ts
// Turn a free-text query into an FTS5 MATCH expression for the trigram tokenizer.
// - split on whitespace
// - keep terms with >= 3 characters (a trigram needs 3 chars; shorter can't match)
// - wrap each term in double quotes (a phrase) with internal quotes doubled, so user
//   text can never inject FTS5 operators or cause a MATCH syntax error
// - OR the terms (lexical supplies candidates; RRF + vector handle precision)
// Returns null when no term qualifies, so the caller does vector-only search.
export function toFtsQuery(text: string): string | null {
  const terms = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => [...t].length >= 3)
  if (terms.length === 0) return null
  return terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
}
```
Fix the Step-1 quote test to match this exact behavior (e.g. `toFtsQuery('say "hi"')` -> `'"say" OR """hi"""'`). Keep tests ASCII-friendly except the one intentional Korean case.

- [ ] **Step 4: Run, watch pass.**

- [ ] **Step 5: Commit**

```bash
git add src/core/fts-query.ts tests/core/fts-query.test.ts
git commit -m "feat(core): safe free-text -> FTS5 trigram MATCH"
```

---

## Task 3: Port + MemoryVectorStore + RecallService (TDD)

**Files:** Modify `src/core/ports.ts`, `src/adapters/memory-vector-store.ts`, `src/core/recall-service.ts`, `tests/core/recall-service.test.ts`

- [ ] **Step 1: Change the port signature**

```ts
// VectorSearchPort: search now also takes the raw query text for the lexical side.
search(queryVector: Float32Array, queryText: string, k: number): Promise<RankedResult[]>
```

- [ ] **Step 2: Update RecallService to pass text**

In `recall-service.ts`, the recall method already has the query text (it embeds it). Change the store call to `this.store.search(queryVector, text, k)`.

- [ ] **Step 3: Make MemoryVectorStore hybrid (so the test double matches the contract)**

In `memory-vector-store.ts` `search`, after computing the existing cosine ranking, also compute a naive lexical ranking (chunks whose lowercased text contains any whitespace-split query term of length >= 3, ordered by number of distinct terms matched), then fuse both id lists with `rrfFuse` and map the top-k back to RankedResult (score = fused score). Import `rrfFuse` from `../core/rrf`. This keeps the in-memory double behaving like the real hybrid store for unit tests.

- [ ] **Step 4: Update recall-service test**

**Scenario:** Recall must return a chunk that matches by EXACT TERM even when another chunk is a closer vector neighbor — proving the lexical side participates.
**Coverage:** ✅ integration (MemoryVectorStore hybrid + RecallService, fake embedder)

Update existing `tests/core/recall-service.test.ts` calls to the new `search(vector, text, k)` signature, and add one case: two chunks where the vector-closest does NOT contain the query's rare term but another chunk does; assert the term-bearing chunk is returned in the top results.

- [ ] **Step 5: Run tests, watch pass.** `npx vitest run tests/core/recall-service.test.ts` -> PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/ports.ts src/core/recall-service.ts src/adapters/memory-vector-store.ts tests/core/recall-service.test.ts
git commit -m "feat(core): hybrid search contract (queryText) + RRF in memory store"
```

---

## Task 4: Worker FTS5 table + hybrid search op

**Files:** Modify `src/offscreen/sqlite-worker.ts`, `src/offscreen/worker-vector-store.ts`, `src/offscreen/offscreen.ts`

- [ ] **Step 1: FTS5 schema + sync triggers + migration (sqlite-worker.ts)**

After the existing SCHEMA/migration on init, create the FTS index and keep it in sync via triggers (text is immutable after insert, so only insert/delete triggers are needed):
```ts
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='rowid', tokenize='trigram'
)`)
db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END`)
db.exec(`CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END`)
// One-time backfill for pre-existing chunks (upgrade): if the FTS is empty but chunks
// exist, rebuild the index from the content table.
let ftsCount = 0, chunkCount = 0
db.exec({ sql: `SELECT count(*) FROM chunks_fts`, rowMode: 'array', callback: (r: any) => { ftsCount = r[0] } })
db.exec({ sql: `SELECT count(*) FROM chunks`, rowMode: 'array', callback: (r: any) => { chunkCount = r[0] } })
if (ftsCount === 0 && chunkCount > 0) {
  db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`)
}
```
(putChunks already does DELETE then INSERT on `chunks`, and deletePagesByHost deletes `chunks` rows — both fire the triggers, so the FTS stays consistent through every path. setVector updates only `vector`, so no trigger/text reindex is needed. If `CREATE VIRTUAL TABLE ... USING fts5` throws because the build lacks FTS5/trigram, fail init loudly — the official sqlite-wasm build includes both.)

- [ ] **Step 2: Rewrite the search handler as hybrid**

Replace `opSearch` so it takes `{ queryVector, queryText, k }`:
```ts
import { rrfFuse } from '../core/rrf'
import { toFtsQuery } from '../core/fts-query'

function opSearch(db: any, { queryVector, queryText, k }: { queryVector: number[]; queryText: string; k: number }): RankedResult[] {
  const N = 50
  // 1. Vector candidates: cosine over embedded chunks, top N ids (ordered best-first).
  //    (Reuse the existing cosine logic but collect {id, cos}, sort desc, slice N.)
  const vec: { id: string; cos: number }[] = []
  db.exec({
    sql: `SELECT c.id AS id, c.vector AS vector FROM chunks c WHERE c.vector IS NOT NULL`,
    rowMode: 'object',
    callback: (r: any) => {
      const v = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4)
      let dot = 0
      for (let i = 0; i < v.length; i++) dot += v[i] * queryVector[i] // both already normalized
      vec.push({ id: r.id, cos: dot })
    },
  })
  vec.sort((a, b) => b.cos - a.cos)
  const vectorIds = vec.slice(0, N).map((x) => x.id)

  // 2. Lexical candidates: FTS5 trigram BM25, top N ids.
  const lexicalIds: string[] = []
  const match = toFtsQuery(queryText)
  if (match) {
    try {
      db.exec({
        sql: `SELECT c.id AS id FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
              WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`,
        bind: [match, N],
        rowMode: 'object',
        callback: (r: any) => lexicalIds.push(r.id),
      })
    } catch {
      // Malformed match (defensive) -> vector-only this query.
    }
  }

  // 3. Fuse and take top k, then hydrate to RankedResult.
  const fused = rrfFuse([vectorIds, lexicalIds]).slice(0, k)
  return fused.map((hit) => hydrate(db, hit.id, hit.score)).filter(Boolean) as RankedResult[]
}
```
Add a `hydrate(db, chunkId, score)` helper that SELECTs the chunk + its page and returns a `RankedResult` ({ chunk, page, score }). (Mirror whatever shape the current opSearch returns — keep RankedResult identical so the popup/types are unchanged; just the `score` is now the RRF score.)

Wire `search` in the handler map to `(db, args) => opSearch(db, args)`.

- [ ] **Step 3: Adapter passes queryText (worker-vector-store.ts)**

```ts
search = (queryVector: Float32Array, queryText: string, k: number) =>
  this.c.request<RankedResult[]>('search', { queryVector: Array.from(queryVector), queryText, k })
```
(Float32Array does not survive RPC -> send as number[]; the worker reads `queryVector` as number[]. Confirm the existing code already converts — match it.)

- [ ] **Step 4: offscreen recall op passes the text (offscreen.ts)**

The recall op embeds the query text to a vector; pass BOTH the vector and the original text into `store.search(vector, text, k)`.

- [ ] **Step 5: Typecheck + build + verify no regression**

Run: `npx tsc --noEmit && npm run build`. Then `npx playwright test tests/e2e/recall-flow.spec.ts` -> still green (semantic recall still works through the hybrid path).

- [ ] **Step 6: Commit**

```bash
git add src/offscreen/sqlite-worker.ts src/offscreen/worker-vector-store.ts src/offscreen/offscreen.ts
git commit -m "feat(offscreen): FTS5 trigram index + hybrid (vector+lexical RRF) search"
```

---

## Task 5: Golden-set e2e (hybrid beats vector-only)

**Files:** Create `tests/e2e/hybrid-search.spec.ts`

- [ ] **Step 1: Write the golden-set e2e**

**Scenario:** Two real wins from hybrid: (a) a query with a RARE EXACT TERM that vector alone tends to miss must surface the page containing that term (lexical win); (b) a purely SEMANTIC query with no shared words must still surface the right page (vector win). Korean + English both covered.
**Coverage:** ✅ integration (real extension, real FTS5 trigram + real embeddings + RRF).

Build a tiny corpus by manual-capturing 3-4 short distinct pages served via `page.route` (use thin <100-word bodies so only deterministic manual captures exist — same technique as forget-history). Suggested docs:
- EN doc containing a rare token, e.g. a made-up product name `Zylophin` in an otherwise unrelated paragraph.
- EN doc about sleep/cortisol (semantic target for "why can't I fall asleep").
- KO doc containing `광합성` / `엽록소` (semantic + term target for a Korean query).

Assertions:
- Query `Zylophin` -> the rare-term page ranks first (lexical win; vector alone would rank it low).
- Query `why can't I fall asleep at night` (no shared words with the cortisol doc) -> the cortisol page appears (vector win).
- Korean query `식물이 빛으로 양분 만드는 법` -> the 광합성 page appears (multilingual hybrid).

Use the `toPass` indexing-wait + popup search pattern from the existing specs.

- [ ] **Step 2: Build + run**

Run: `npm run build && npx playwright test tests/e2e/hybrid-search.spec.ts` -> PASS.

- [ ] **Step 3: Full suite**

Run: `npm run test && npx playwright test` -> all green (existing recall-flow/persistence/auto-capture/user-controls/forget-history/spa + new hybrid).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/hybrid-search.spec.ts
git commit -m "test(e2e): hybrid search golden set (lexical + semantic, KO + EN)"
```

---

## Self-Review

**Spec coverage:**
- Lexical via FTS5 trigram (multilingual): Task 4 (table/triggers/migration). ✅
- RRF fusion: Task 1 (pure) + Task 4 (wired). ✅
- Safe multilingual query handling: Task 2 (pure). ✅
- Hybrid replaces vector-only end-to-end: Task 3 (port/service) + Task 4 (worker). ✅
- Quality proven (golden set, KO+EN, lexical-win + vector-win): Task 5. ✅

**Notes / risks:**
- FTS5 + trigram must be compiled into the sqlite-wasm build (official build has both). Task 4 Step 1 fails loudly if not.
- External-content FTS5 relies on the implicit integer `rowid` of `chunks` (it is NOT `WITHOUT ROWID`), so `rowid` is stable per row. Triggers reference `new.rowid`/`old.rowid`.
- `putChunks` (DELETE+INSERT) and `deletePagesByHost` (DELETE) drive the triggers, so the FTS stays consistent; `setVector` touches only `vector` (no reindex). No INSERT-OR-REPLACE happens on `chunks`.
- The migration backfill (`rebuild`) runs once when upgrading an existing profile (FTS empty, chunks present). Must not break the persistence e2e — run the full suite in Task 5.
- RRF score is small (≈0.016 at rank 1); the popup shows it as the relative score. If that reads oddly, a later cosmetic task can hide the number — out of scope here.
- N=50 and RRF k=60 are reasonable defaults; tune later if golden-set recall suggests it.

# Search-Quality Golden-Set Eval + Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-pipeline, real-model golden-set eval harness (`npm run eval`) that measures recall quality, record a BASELINE, then apply four ranked search-quality fixes one at a time, each proven by a number that moves on the same harness.

**Architecture:** Hexagonal — every fix has a PURE core function (`prose-score`, `boilerplate-strip`, `eval-metrics`, `chooseSnippetChunk`, weighted `rrfFuse`) that is unit-tested fast in `npm run test`. The slow real-model embedding + orchestration is `npm run eval` glue that reuses the REAL `ParagraphChunker`, the REAL `CaptureService`, the REAL `MemoryVectorStore.search` (same `rrfFuse` + `topPagesBySnippet` as the production `opSearch`, per ADR 0020), and the same `query:`/`passage:` prefixes + `dtype:'q8'` quantization the extension uses. Fixes land in BOTH engines (`memory-vector-store.ts` AND `sqlite-worker.ts`) so the two stay semantically identical.

**Tech Stack:** `@huggingface/transformers` (e5 multilingual-small, q8, run in Node, model loaded from the bundled `public/models/` dir, no network) · Vitest (node env, pure unit tests) · existing `src/core` hexagonal stack · ADR 0004 (golden-set-driven), ADR 0019 (FTS5/RRF hybrid), ADR 0020 (document-level results).

**Decisions (confirmed — baked in from a grilling session):**
- **Empirical, scenario-driven golden set.** Build a REAL corpus by indexing many real pages with the real model, discover failures, codify them as cases, then fix — measured before/after. Not a toy guard, not a giant IR benchmark.
- **Balanced/general corpus (~25-35 pages), NOT dev-skewed.** Reference-heavy Wikipedia, general blogs, docs pages, news, a couple of GitHub PR/issue pages (incl. the real failing "ingestion" case), and several KOREAN articles for cross-lingual. Each page records its SOURCE url in the manifest.
- **Fixtures = pre-extracted block-joined TEXT (`.txt`) + a JSON manifest**, NOT committed HTML. Justification: text is ~10-50x smaller than raw HTML (keeps the repo lean), it is exactly what `ParagraphChunker` consumes (so the eval starts one formatting step downstream of Readability — the library we do NOT change), and it loads instantly with zero DOM dependency in Node. The references/boilerplate are KEPT in the fixture text (pre-strip) so Fix 1 has something to strip and the baseline shows the regression.
- **Real-model-in-Node, NOT recorded vectors.** Recorded vectors go stale the moment the chunker changes and would HIDE the exact bug. Run the real e5 model (proven by `tests/core/embedding-model.node.test.ts`), pinned to the bundled model dir + `dtype:'q8'` to match production.
- **`npm run eval` is separate from `npm run test`** (it is slow — ~1-2 min). A small thresholded subset gates in CI.
- **Headline metric = reference-snippet-rate** (the regression number), alongside precision@1, recall@5, MRR.

---

## Background (read before starting)

Read `docs/search-quality-analysis.md` in full — it is the root-cause analysis this plan operationalizes. One-line root cause: extraction never removes Wikipedia boilerplate (References / Notes / See also / External links / Bibliography), so citation-dense chunks get embedded and out-score the lead prose on topic queries, and the snippet picker (`topPagesBySnippet`) has zero prose preference, so the displayed snippet becomes a citation list.

Key real-code facts confirmed against the repo (some differ from the analysis — noted):
- `src/content/capture.ts` `extract()` uses `new Readability(docClone).parse()` then `article.textContent` — no boilerplate removal anywhere.
- `src/core/paragraph-chunker.ts` splits on `/\s+/`, accumulates 220 words/chunk, no boilerplate filtering.
- `src/core/ports.ts` `VectorSearchPort.search(queryVector, queryText, k)` is ALREADY 3-arg (hybrid landed) — both `MemoryVectorStore.search` and the worker `opSearch` already do `rrfFuse([vectorIds, lexicalIds]) -> hydrate -> topPagesBySnippet`.
- **Discrepancy 1 (snippet swap location):** the analysis (section 4, Fix C) says the prose-preferred snippet swap goes "in `topPagesBySnippet` or just after." But in the real code BOTH lanes reduce to ONE chunk per page BEFORE fusion (`vecBestByPage` keeps only the max-cosine chunk per page; the lexical lane keeps the first chunk per page). So `topPagesBySnippet` only ever sees ~1-2 chunks per page and CANNOT choose an alternate prose chunk. The swap must happen in the VECTOR LANE reduction (where all of a page's chunks are still visible). This plan puts it there (Fix 3 / Task 7).
- **Discrepancy 2 (offline model):** the analysis says "the repo already bundles the model in `public/models/` so the harness can be network-free." In fact `public/models/` is `.gitignore`d and only the `config.json`/`tokenizer*.json` are present locally; the ONNX weights (`onnx/model_quantized.onnx`) are fetched at build time by `scripts/fetch-model.mjs` (`prebuild`). So the harness IS network-free ONLY AFTER `node scripts/fetch-model.mjs` has run once. The harness must (a) run/ensure that fetch, then (b) point `env.localModelPath` at `public/models/` with `allowRemoteModels=false` and `dtype:'q8'`. The existing `embedding-model.node.test.ts` does NOT do this (it downloads from HF with default dtype) — the harness deliberately differs to match production quantization.

---

## File Structure

```
eval/
  fixtures/*.txt          # NEW: pre-extracted, block-joined page text (references KEPT). ASCII filenames.
  manifest.json           # NEW: [{ id, file, url, source, lang, note }] — the corpus index + provenance
  golden.json             # NEW: [{ scenario, query, expectTopPageIds, expectProseSnippet }] — queries + expected
  run.mjs                 # NEW: harness entry — extract(strip?)->chunk->embed->search->metrics->scorecard
  lib/embed-node.mjs      # NEW: real e5 model in Node (local model dir, dtype q8, query:/passage: prefixes)
  lib/build-and-search.mjs# NEW: glue — wires CaptureService + chunker + store + embedder, runs a query
  last-scorecard.json     # GENERATED (committed alongside each fix as before/after evidence)
  .cache/                 # transformers cache (gitignored)

src/core/
  prose-score.ts          # NEW (PURE, TDD): proseScore(text): number in [0,1]
  boilerplate-strip.ts    # NEW (PURE, TDD): stripBoilerplate(text): string
  eval-metrics.ts         # NEW (PURE, TDD): precisionAt1 / recallAtK / mrr / referenceSnippetRate / aggregate
  ranking.ts              # MODIFY: add chooseSnippetChunk (PURE); topPagesBySnippet unchanged
  rrf.ts                  # MODIFY: rrfFuse gains optional per-list weights (default = current behavior)
  capture-service.ts      # MODIFY: optional minProseScore filter at index time, with all-dropped guard
src/adapters/
  memory-vector-store.ts  # MODIFY: vector lane groups all chunks per page; chooseSnippetChunk; weighted rrf
src/offscreen/
  sqlite-worker.ts        # MODIFY: vector lane groups all chunks per page; chooseSnippetChunk; weighted rrf
src/content/
  capture.ts              # MODIFY (glue, Coverage N/A): wire stripBoilerplate into extract() via DOMParser block-join

tests/core/
  prose-score.test.ts         # NEW
  boilerplate-strip.test.ts   # NEW
  eval-metrics.test.ts        # NEW
  ranking.test.ts             # MODIFY: add chooseSnippetChunk + snippet-preference cases
  rrf.test.ts                 # MODIFY: add weighted-fusion case
  capture-service.test.ts     # MODIFY: add prose-filter + all-dropped-guard cases

package.json              # MODIFY: add "eval" script + "eval:fetch-model" helper
.gitignore                # MODIFY: ignore eval/.cache
```

All test files are ASCII-only (repo rule). Korean queries/corpus live ONLY in DATA files (`golden.json`, `eval/fixtures/*.txt`); Korean strings inside `.test.ts` source are written with `\u` escapes when unavoidable.

---

## Task 1: Pure eval metrics (TDD)

**Files:**
- Create: `src/core/eval-metrics.ts`
- Test: `tests/core/eval-metrics.test.ts`

The harness needs these to score any ranked list. They are pure list-math — no model.

- [ ] **Step 1: Write the failing test**

**Scenario:** A ranked list of page ids plus the expected page id must produce the standard retrieval numbers; the regression-specific `referenceSnippetRate` must count queries whose TOP result snippet is non-prose (citation list).
**Coverage:** ✅ integration (pure functions, real arithmetic).

```ts
import {
  precisionAt1,
  recallAtK,
  mrr,
  referenceSnippetRate,
  aggregate,
} from '../../src/core/eval-metrics'

test('precisionAt1 is 1 only when the first id is expected', () => {
  expect(precisionAt1(['a', 'b'], ['a'])).toBe(1)
  expect(precisionAt1(['b', 'a'], ['a'])).toBe(0)
  expect(precisionAt1([], ['a'])).toBe(0)
})

test('recallAtK is 1 when any expected id is within the first k', () => {
  expect(recallAtK(['x', 'a', 'y'], ['a'], 5)).toBe(1)
  expect(recallAtK(['x', 'y', 'z', 'w', 'v', 'a'], ['a'], 5)).toBe(0) // a is at rank 6
  expect(recallAtK(['x'], ['a'], 5)).toBe(0)
})

test('mrr is the reciprocal rank of the first expected id (0 if absent)', () => {
  expect(mrr(['a', 'b'], ['a'])).toBe(1)
  expect(mrr(['b', 'a'], ['a'])).toBe(0.5)
  expect(mrr(['b', 'c'], ['a'])).toBe(0)
})

test('referenceSnippetRate is the fraction of queries whose top snippet is non-prose', () => {
  // each entry: did the top-1 result snippet pass the prose threshold?
  expect(referenceSnippetRate([{ topIsProse: false }, { topIsProse: true }])).toBe(0.5)
  expect(referenceSnippetRate([{ topIsProse: true }, { topIsProse: true }])).toBe(0)
  expect(referenceSnippetRate([])).toBe(0)
})

test('aggregate averages per-query metrics', () => {
  const agg = aggregate([
    { p1: 1, r5: 1, rr: 1 },
    { p1: 0, r5: 1, rr: 0.5 },
  ])
  expect(agg.precisionAt1).toBe(0.5)
  expect(agg.recallAt5).toBe(1)
  expect(agg.mrr).toBe(0.75)
})
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/core/eval-metrics.test.ts`
Expected: FAIL — "Cannot find module '../../src/core/eval-metrics'".

- [ ] **Step 3: Implement**

```ts
// src/core/eval-metrics.ts
// Pure retrieval metrics for the golden-set harness. Inputs are already-ranked PAGE-id
// lists plus the expected page id(s). Single relevant doc per query, so recall@k is binary.

export function precisionAt1(ranked: string[], expected: string[]): number {
  return ranked.length > 0 && expected.includes(ranked[0]) ? 1 : 0
}

export function recallAtK(ranked: string[], expected: string[], k: number): number {
  return ranked.slice(0, k).some((id) => expected.includes(id)) ? 1 : 0
}

export function mrr(ranked: string[], expected: string[]): number {
  const i = ranked.findIndex((id) => expected.includes(id))
  return i === -1 ? 0 : 1 / (i + 1)
}

// The headline regression number. Each query contributes whether its TOP-1 result's
// snippet read as prose (true) or as a citation/boilerplate list (false). The rate is
// the fraction that were NON-prose — i.e. the bug rate. Lower is better; the fix target
// is 0.
export function referenceSnippetRate(perQuery: { topIsProse: boolean }[]): number {
  if (perQuery.length === 0) return 0
  const bad = perQuery.filter((q) => !q.topIsProse).length
  return bad / perQuery.length
}

export interface PerQuery { p1: number; r5: number; rr: number }
export function aggregate(rows: PerQuery[]): { precisionAt1: number; recallAt5: number; mrr: number } {
  if (rows.length === 0) return { precisionAt1: 0, recallAt5: 0, mrr: 0 }
  const sum = (sel: (r: PerQuery) => number) => rows.reduce((a, r) => a + sel(r), 0) / rows.length
  return { precisionAt1: sum((r) => r.p1), recallAt5: sum((r) => r.r5), mrr: sum((r) => r.rr) }
}
```

- [ ] **Step 4: Run, watch pass**

Run: `npx vitest run tests/core/eval-metrics.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/eval-metrics.ts tests/core/eval-metrics.test.ts
git commit -m "feat(core): pure golden-set eval metrics (p@1, recall@k, MRR, reference-snippet-rate)"
```

---

## Task 2: Pure prose score (TDD)

**Files:**
- Create: `src/core/prose-score.ts`
- Test: `tests/core/prose-score.test.ts`

`proseScore` is the shared heuristic behind the headline metric (Task 1's `referenceSnippetRate` consumes it via the harness), the index-time filter (Fix 2), and the snippet swap (Fix 3).

- [ ] **Step 1: Write the failing test**

**Scenario:** A lead/intro paragraph must score HIGH (prose); a Wikipedia citation chunk (dense with DOIs/PMIDs/years, low alpha-word ratio) must score LOW, so downstream code can drop or de-prioritize it.
**Coverage:** ✅ integration (pure function, fixed ASCII samples).

```ts
import { proseScore } from '../../src/core/prose-score'

// A real-shaped lead paragraph (prose).
const LEAD =
  'Bacteria are ubiquitous, mostly free-living organisms often consisting of one ' +
  'biological cell. They constitute a large domain of prokaryotic microorganisms and ' +
  'were among the first life forms to appear on Earth.'

// A real-shaped citation chunk (boilerplate): journal names, DOIs, PMIDs, years.
const CITATION =
  'Douady CJ, Papke RT (2003). "Lateral gene transfer". Journal of Experimental Botany. ' +
  '56 (417): 1761-78. doi:10.1093/jxb/eri197. PMID 12498710. S2CID 8521523. ISSN 0022-0957. ' +
  'Bibcode 2003JXB....56.1761D. Retrieved 2019-03-14.'

test('lead prose scores high', () => {
  expect(proseScore(LEAD)).toBeGreaterThan(0.7)
})

test('citation chunk scores low', () => {
  expect(proseScore(CITATION)).toBeLessThan(0.35)
})

test('prose outscores citation', () => {
  expect(proseScore(LEAD)).toBeGreaterThan(proseScore(CITATION))
})

test('empty text scores 0 (no prose to show)', () => {
  expect(proseScore('')).toBe(0)
  expect(proseScore('   ')).toBe(0)
})

test('score is clamped to [0,1]', () => {
  const s = proseScore(CITATION)
  expect(s).toBeGreaterThanOrEqual(0)
  expect(s).toBeLessThanOrEqual(1)
})
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/core/prose-score.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/core/prose-score.ts
// How much does a chunk read like running prose (intro/explanation) vs. a citation /
// boilerplate list? 1 = clean prose, 0 = dense citation list. Pure + deterministic so it
// can drive the eval metric, the index-time filter (Fix 2), and the snippet swap (Fix 3).
//
// Signals (cheap, language-agnostic — works for English AND Korean prose because the
// alpha-word test accepts any Unicode LETTER, not just A-Z):
//   digitDensity   = digit chars / total chars        (citation lists are year/page-number heavy)
//   alphaWordRatio = words starting with a letter / words  (citations are number/punctuation heavy)
//   citeMarkers    = count of doi|PMID|PMC|ISSN|ISBN|Bibcode|arXiv|S2CID  (smoking gun)
// Link density is intentionally NOT used here: the input is already plain text (links are
// gone after extraction), so there is nothing to measure. It belongs to a future
// DOM-level signal, out of scope for this text function.
const CITE_MARKER = /\b(doi|PMID|PMC|ISSN|ISBN|Bibcode|arXiv|S2CID)\b/gi

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export function proseScore(text: string): number {
  const t = text.trim()
  if (t.length === 0) return 0

  const chars = [...t]
  const digitCount = chars.filter((c) => c >= '0' && c <= '9').length
  const digitDensity = digitCount / chars.length

  const words = t.split(/\s+/).filter((w) => w.length > 0)
  // A "word" starts with a Unicode letter (English, Korean, etc.) — not a digit/quote/paren.
  const alphaWords = words.filter((w) => /^[\p{L}]/u.test(w)).length
  const alphaWordRatio = words.length === 0 ? 0 : alphaWords / words.length

  const citeMarkers = (t.match(CITE_MARKER) ?? []).length

  return clamp(
    1
      - 2.0 * Math.max(0, digitDensity - 0.04)
      - 0.8 * Math.max(0, 0.7 - alphaWordRatio)
      - 0.05 * citeMarkers,
    0,
    1,
  )
}
```

- [ ] **Step 4: Run, watch pass**

Run: `npx vitest run tests/core/prose-score.test.ts`
Expected: PASS (5 tests). If `CITATION` does not land below 0.35, the citation sample is the ground truth — tune the coefficients (not the test threshold) until the real citation shape fails and the real lead passes; that gap IS the heuristic's job.

- [ ] **Step 5: Commit**

```bash
git add src/core/prose-score.ts tests/core/prose-score.test.ts
git commit -m "feat(core): pure proseScore heuristic (citation vs prose)"
```

---

## Task 3: Build the corpus (fixtures + manifest + golden set)

**Files:**
- Create: `eval/fixtures/*.txt` (~25-35 files)
- Create: `eval/manifest.json`
- Create: `eval/golden.json`

This is DATA, not code. No TDD — the validation is that the harness (Task 4) loads it and runs.

**Coverage:** N/A (corpus data — exercised end-to-end by the harness in Task 4+).

- [ ] **Step 1: Capture the corpus pages and save extracted text**

For each page below: open it in the recall extension (or run the one-off extractor in Step 2), let it capture, and save the EXTRACTED text (references KEPT — do NOT pre-strip) to `eval/fixtures/<id>.txt`. Filenames ASCII only (e.g. `wiki-bacteria.txt`, `ko-photosynthesis.txt`).

Corpus composition (balanced/general, NOT dev-skewed — ~25-35 pages):
- **Reference-heavy Wikipedia (English, ~8-10):** Bacteria, Protein, Biology, Photosynthesis, Cortisol, Mitochondrion, Sleep, Immune system, DNA, Cell (biology). These are the citation-pollution cases.
- **General blogs (~4):** a couple of long-form personal/tech blog posts (boilerplate shape differs from Wikipedia — footers, "related posts" — exercises Fix 2 safety net).
- **Docs pages (~3):** e.g. an MDN page, a framework docs page, a library README rendered page.
- **News articles (~3):** general news (politics/science/tech), each with its own boilerplate (bylines, "read more").
- **GitHub PR/issue pages (~2):** include the REAL failing case — a PR/issue whose text literally contains the word "ingestion" (this is S2's target), plus one more.
- **Korean articles (~5):** Korean Wikipedia and/or Korean blog/news (cross-lingual S3 targets). Reuse `tests/e2e/fixtures/ko-photosynthesis.html`-style content where useful, but store as extracted `.txt` here.

- [ ] **Step 2: One-off extractor (how each fixture is produced)**

Block-joined text is what makes Fix 1's heading detection reliable (each section heading lands on its own line). Produce fixtures with this helper so they match what production `extract()` will emit after Task 5. Run it per page (manual; not committed as a build step):

```js
// eval/lib/extract-fixture.mjs  (dev helper, run by hand: node eval/lib/extract-fixture.mjs <url> <id>)
// Fetches a URL, runs the SAME Readability the extension uses, then joins block-level
// elements with newlines so headings (References, See also, ...) are isolated lines.
import { writeFileSync } from 'node:fs'
import { Readability } from '@mozilla/readability'
// linkedom is a tiny DOM for Node; add as a devDependency for this helper only.
import { parseHTML } from 'linkedom'

const [url, id] = process.argv.slice(2)
const html = await (await fetch(url)).text()
const { document } = parseHTML(html)
const article = new Readability(document).parse()
// Build a DOM from the cleaned content HTML, join block elements with "\n".
const { document: cdoc } = parseHTML(`<body>${article.content}</body>`)
const blocks = [...cdoc.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre')]
const text = blocks.map((b) => b.textContent.trim()).filter(Boolean).join('\n')
writeFileSync(`eval/fixtures/${id}.txt`, text)
console.log(`${id}: ${text.length} chars`)
```

Add `linkedom` as a devDependency (`npm i -D linkedom`) — it is used ONLY by this dev helper and never by the extension bundle. (The runtime extension uses the browser's native DOM; see Task 5.)

- [ ] **Step 3: Write the manifest (corpus index + provenance)**

`eval/manifest.json` — one row per fixture. `id` MUST equal `pageIdFromUrl(url)` (from `src/core/capture-service.ts`) so the harness's stored page id matches what `expectTopPageIds` references.

```jsonc
[
  { "id": "https://en.wikipedia.org/wiki/Bacteria", "file": "wiki-bacteria.txt",
    "url": "https://en.wikipedia.org/wiki/Bacteria", "source": "Wikipedia", "lang": "en",
    "note": "reference-heavy; S1 + S2 decoy (Protein Digestion section)" },
  { "id": "https://en.wikipedia.org/wiki/Protein", "file": "wiki-protein.txt",
    "url": "https://en.wikipedia.org/wiki/Protein", "source": "Wikipedia", "lang": "en",
    "note": "contains a 'Protein digestion' reference chunk -> S2 false-positive risk" },
  { "id": "https://en.wikipedia.org/wiki/Cortisol", "file": "wiki-cortisol.txt",
    "url": "https://en.wikipedia.org/wiki/Cortisol", "source": "Wikipedia", "lang": "en",
    "note": "S4 paraphrase target (hormone that ruins sleep)" },
  { "id": "https://github.com/OWNER/REPO/pull/NNN", "file": "gh-ingestion-pr.txt",
    "url": "https://github.com/OWNER/REPO/pull/NNN", "source": "GitHub", "lang": "en",
    "note": "REAL failing case: literally contains 'ingestion' -> S2 target" }
  // ... one row per fixture (~25-35 total). Korean rows use "lang": "ko".
]
```

- [ ] **Step 4: Write the golden set (queries + expected)**

`eval/golden.json` — each entry tags its scenario so the scorecard can break down per-scenario. `query` is the RAW user text (Korean allowed — this is a data file). `expectTopPageIds` are the page id(s) that should rank #1. `expectProseSnippet: true` means the top result's snippet must be prose (else it counts toward reference-snippet-rate).

```jsonc
[
  // S1 reference-snippet pollution: topic query, snippet must be PROSE not a citation list.
  { "scenario": "S1", "query": "bacteria",
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Bacteria"], "expectProseSnippet": true },
  { "scenario": "S1", "query": "박테리아",
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Bacteria"], "expectProseSnippet": true },

  // S2 exact-term relevance: "ingestion" must surface the ingestion PR, NOT the Protein
  // page's "Protein digestion" reference chunk.
  { "scenario": "S2", "query": "ingestion",
    "expectTopPageIds": ["https://github.com/OWNER/REPO/pull/NNN"], "expectProseSnippet": true },

  // S3 cross-lingual: Korean query -> correct English page.
  { "scenario": "S3", "query": "광합성 명반응",
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Photosynthesis"], "expectProseSnippet": true },

  // S4 paraphrase (pure semantic, NO shared words / no lexical signal): must NOT regress
  // when Fix 4 up-weights the lexical lane.
  { "scenario": "S4", "query": "hormone that ruins sleep",
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Cortisol"], "expectProseSnippet": true },

  // S5 global snippet quality: EVERY scenario above also asserts expectProseSnippet:true;
  // S5 is the aggregate reference-snippet-rate over the whole set (computed by the harness),
  // not a separate query.
  { "scenario": "S5", "query": "what is a protein",
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Protein"], "expectProseSnippet": true }
]
```

- [ ] **Step 5: Commit**

```bash
git add eval/fixtures eval/manifest.json eval/golden.json eval/lib/extract-fixture.mjs package.json package-lock.json
git commit -m "test(eval): golden-set corpus (wiki/blog/docs/news/github + korean) + manifest + queries"
```

---

## Task 4: The harness + baseline scorecard

**Files:**
- Create: `eval/lib/embed-node.mjs`
- Create: `eval/lib/build-and-search.mjs`
- Create: `eval/run.mjs`
- Create: `eval/last-scorecard.json` (generated)
- Modify: `package.json` (scripts), `.gitignore`

This is the slow real-model glue. It is `Coverage: N/A` — the unit-tested core (`eval-metrics`, `prose-score`, and the fix functions in later tasks) carries the correctness; this orchestrates them over the real model so the BASELINE is honest.

**Coverage:** N/A — orchestration glue. Justification: real-model embedding + the real `MemoryVectorStore.search` cannot be a fast unit test (real path is the whole point); every PURE decision it makes is unit-tested in Tasks 1-2 and 5-8.

- [ ] **Step 1: Real e5 embedder in Node (matches production)**

```js
// eval/lib/embed-node.mjs
// Real multilingual-e5-small in Node, loaded from the BUNDLED model dir (no network),
// quantized to q8 to MATCH the extension (src/offscreen/webgpu-embedder.ts uses dtype:'q8').
// Mirrors the prod prefixes: queries get "query: ", passages get "passage: ".
import { pipeline, env } from '@huggingface/transformers'
import { resolve } from 'node:path'

env.allowRemoteModels = false                 // offline + deterministic
env.localModelPath = resolve('public/models') // the bundled dir (filled by scripts/fetch-model.mjs)
env.cacheDir = resolve('eval/.cache')

let _pipe
async function pipe() {
  if (!_pipe) _pipe = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' })
  return _pipe
}

export async function embed(texts, kind /* 'query' | 'passage' */) {
  const p = await pipe()
  const prefixed = texts.map((t) => `${kind}: ${t}`)
  const out = await p(prefixed, { pooling: 'mean', normalize: true })
  return out.tolist().map((a) => new Float32Array(a))
}
```

- [ ] **Step 2: Build store + run a query (reuses the REAL pipeline)**

```js
// eval/lib/build-and-search.mjs
// Reuses the REAL chunker, CaptureService, and MemoryVectorStore.search (same rrfFuse +
// topPagesBySnippet as the production opSearch, per ADR 0020). Fixes land in those files,
// so this glue exercises every fix end to end without re-implementing ranking.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ParagraphChunker } from '../../src/core/paragraph-chunker.ts'
import { CaptureService } from '../../src/core/capture-service.ts'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store.ts'
import { stripBoilerplate } from '../../src/core/boilerplate-strip.ts' // exists after Task 5
import { embed } from './embed-node.mjs'

// Build a store from the whole corpus once. `opts.strip` and `opts.minProse` toggle the
// fixes that live at capture/extraction time so one process can produce before/after numbers.
export async function buildStore(manifest, opts) {
  const store = new MemoryVectorStore()
  const capture = new CaptureService(new ParagraphChunker(220), store, opts.minProse ?? 0)
  for (const row of manifest) {
    let text = readFileSync(resolve('eval/fixtures', row.file), 'utf8')
    if (opts.strip) text = stripBoilerplate(text)
    await capture.capture({ url: row.url, title: row.id, text })
  }
  // Embed every pending chunk (passage:) and store the vector.
  const pending = await store.pendingChunks(1e9)
  const vectors = await embed(pending.map((c) => c.text), 'passage')
  for (let i = 0; i < pending.length; i++) await store.setVector(pending[i].id, vectors[i])
  return store
}

export async function runQuery(store, query, k) {
  const [qvec] = await embed([query], 'query')
  return store.search(qvec, query, k) // RankedResult[]
}
```

NOTE: `eval/run.mjs` runs the TS sources directly. Use the same TS-in-node path the repo already uses for node tests (vitest/esbuild). If `node` cannot import `.ts` directly, invoke the harness through vitest (`vitest run eval/run.mjs` as a one-off node script) OR add `--import tsx` — pick whichever the repo's toolchain already supports; do not add a new transpiler if one is present. (Before Task 5 lands `boilerplate-strip.ts`, the `opts.strip` path is unused, so baseline import works once that file exists; sequence Task 5's file creation before the first `--strip` run.)

- [ ] **Step 3: The runner + scorecard**

```js
// eval/run.mjs
// Usage: node eval/run.mjs [--strip] [--min-prose=0.35] [--lexical-weight=2]
// Prints a per-query + per-scenario scorecard and writes eval/last-scorecard.json.
import { readFileSync, writeFileSync } from 'node:fs'
import { buildStore, runQuery } from './lib/build-and-search.mjs'
import { proseScore } from '../src/core/prose-score.ts'
import { precisionAt1, recallAtK, mrr, referenceSnippetRate, aggregate } from '../src/core/eval-metrics.ts'

const args = process.argv.slice(2)
const strip = args.includes('--strip')
const minProse = Number(args.find((a) => a.startsWith('--min-prose='))?.split('=')[1] ?? 0)
const TAU = 0.35 // prose threshold for "is this snippet a citation list?"
const K = 5

const manifest = JSON.parse(readFileSync('eval/manifest.json', 'utf8'))
const golden = JSON.parse(readFileSync('eval/golden.json', 'utf8'))

const store = await buildStore(manifest, { strip, minProse })

const rows = []
for (const g of golden) {
  const results = await runQuery(store, g.query, K)
  const rankedPageIds = results.map((r) => r.page.id)
  const topSnippet = results[0]?.chunk.text ?? ''
  const topIsProse = results.length > 0 && proseScore(topSnippet) >= TAU
  rows.push({
    scenario: g.scenario, query: g.query, topPage: rankedPageIds[0] ?? '(none)',
    p1: precisionAt1(rankedPageIds, g.expectTopPageIds),
    r5: recallAtK(rankedPageIds, g.expectTopPageIds, K),
    rr: mrr(rankedPageIds, g.expectTopPageIds),
    topIsProse,
  })
}

const agg = aggregate(rows)
const refRate = referenceSnippetRate(rows)

// Print scorecard.
console.log('SCEN  P@1  R@5  RR    refProse  query -> topPage')
for (const r of rows) {
  console.log(
    `${r.scenario.padEnd(5)} ${r.p1}    ${r.r5}    ${r.rr.toFixed(2)}  ` +
    `${r.topIsProse ? 'prose ' : 'CITE! '}  ${r.query} -> ${r.topPage}`,
  )
}
console.log('---')
console.log(
  `P@1=${agg.precisionAt1.toFixed(2)}  recall@5=${agg.recallAt5.toFixed(2)}  ` +
  `MRR=${agg.mrr.toFixed(2)}  reference-snippet-rate=${refRate.toFixed(2)}`,
)

writeFileSync('eval/last-scorecard.json', JSON.stringify({ strip, minProse, agg, refRate, rows }, null, 2))
```

- [ ] **Step 4: package.json scripts + gitignore**

```jsonc
// package.json "scripts" — add:
"eval:fetch-model": "node scripts/fetch-model.mjs",
"eval": "npm run eval:fetch-model && node eval/run.mjs"
```
`eval:fetch-model` materializes `public/models/.../onnx/model_quantized.onnx` (gitignored), making the run network-free thereafter. Add to `.gitignore`:
```
eval/.cache/
eval/last-scorecard.json
```
(Commit a COPY of each milestone scorecard under a named file when you want it as evidence — see commit steps — but keep the live `last-scorecard.json` ignored.)

- [ ] **Step 5: Run the BASELINE (no fixes) and record it**

Run: `npm run eval`
Expected (the regression, reproduced — matches the analysis):
- `reference-snippet-rate` is HIGH (≈1.0 on the Wikipedia topic queries — the snippet is a citation list).
- S2 (`ingestion`) FAILS: `p1=0` — the top page is the Protein page's "Protein digestion" reference chunk, not the ingestion PR.
- Some S1 queries may still get `p1=1` (ranking accidentally right) while `refProse=CITE!` — proving "rank right, snippet garbage" as a SEPARATE number.

Save the baseline as evidence:
```bash
cp eval/last-scorecard.json eval/scorecard-00-baseline.json
git add eval/lib eval/run.mjs eval/scorecard-00-baseline.json package.json .gitignore
git commit -m "test(eval): real-model golden-set harness + BASELINE scorecard (ref-snippet-rate ~1.0, S2 fails)"
```

---

## Task 5: Fix 1 — strip boilerplate sections at extraction (TDD)

**Files:**
- Create: `src/core/boilerplate-strip.ts`
- Test: `tests/core/boilerplate-strip.test.ts`
- Modify: `src/content/capture.ts` (wire it — glue, Coverage N/A)

Root-cause fix: remove References/Notes/See also/External links/Bibliography/Further reading/Sources/Citations sections BEFORE chunking, so citation chunks never enter the index (fixes BOTH ranking and snippet).

- [ ] **Step 1: Write the failing test**

**Scenario:** Block-joined extracted text that ends in a References/See also/External links block must come back with the body intact and the boilerplate tail removed; a page with NO such heading must be returned unchanged.
**Coverage:** ✅ integration (pure text->text function, fixed ASCII multi-line samples).

```ts
import { stripBoilerplate } from '../../src/core/boilerplate-strip'

const BODY = [
  'Bacteria are ubiquitous, mostly free-living organisms.',
  'They constitute a large domain of prokaryotic microorganisms.',
].join('\n')

test('removes a trailing References section and everything after it', () => {
  const input = [BODY, 'References', '1. Some Author (2003). doi:10.1/x. PMID 123.'].join('\n')
  const out = stripBoilerplate(input)
  expect(out).toContain('Bacteria are ubiquitous')
  expect(out).not.toContain('References')
  expect(out).not.toContain('PMID 123')
})

test('removes from the FIRST boilerplate heading to end (See also + External links stacked)', () => {
  const input = [BODY, 'See also', 'Related topic', 'External links', 'http://example.org'].join('\n')
  const out = stripBoilerplate(input)
  expect(out).toContain('large domain')
  expect(out).not.toContain('See also')
  expect(out).not.toContain('External links')
  expect(out).not.toContain('example.org')
})

test('heading match is case-insensitive and tolerates a trailing [edit]', () => {
  const input = [BODY, 'NOTES [edit]', 'a footnote'].join('\n')
  expect(stripBoilerplate(input)).not.toContain('footnote')
})

test('a page with no boilerplate heading is returned unchanged', () => {
  expect(stripBoilerplate(BODY)).toBe(BODY)
})

test('a boilerplate WORD inside a sentence (not its own line) is NOT a cut point', () => {
  const input = 'See the references in the appendix for more on bacteria growth.'
  expect(stripBoilerplate(input)).toBe(input) // conservative: only a stand-alone heading line cuts
})
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/core/boilerplate-strip.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/core/boilerplate-strip.ts
// Remove trailing boilerplate sections (References / Notes / See also / External links /
// Bibliography / Further reading / Sources / Citations) from EXTRACTED, block-joined text
// (one block per line — see extract() in capture.ts). On Wikipedia these sections are all
// stacked at the very bottom, so the robust, conservative rule is: find the EARLIEST line
// in the tail that is EXACTLY a known heading, and drop from there to the end.
//
// "Conservative" guards against over-stripping body text:
//   - the line must EQUAL a heading (after lowercasing, trimming, stripping a trailing
//     "[edit]") — a sentence that merely mentions "references" is never a cut point;
//   - only cut when the heading is in the LATTER portion of the document (>= 40% down),
//     so an early "Notes" callout box does not delete the article.
const HEADINGS = new Set([
  'references', 'reference', 'notes', 'note', 'citations', 'see also',
  'external links', 'further reading', 'bibliography', 'sources',
])

function isHeadingLine(line: string): boolean {
  const norm = line.trim().toLowerCase().replace(/\s*\[edit\]\s*$/, '').trim()
  return HEADINGS.has(norm)
}

export function stripBoilerplate(text: string): string {
  const lines = text.split('\n')
  const minIndex = Math.floor(lines.length * 0.4) // only cut in the tail
  let cut = -1
  for (let i = minIndex; i < lines.length; i++) {
    if (isHeadingLine(lines[i])) { cut = i; break }
  }
  if (cut === -1) return text
  return lines.slice(0, cut).join('\n').replace(/\n+$/, '')
}
```

- [ ] **Step 4: Run, watch pass**

Run: `npx vitest run tests/core/boilerplate-strip.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into production extraction (glue — Coverage N/A)**

In `src/content/capture.ts`, change `extract()` so it (a) builds a DOM from Readability's `content` HTML using the browser-native `DOMParser`, (b) joins block elements with `\n` (so headings are isolated lines — matching the fixtures), then (c) runs `stripBoilerplate`. The browser has `DOMParser` natively — no new dependency.

```ts
import { stripBoilerplate } from '../core/boilerplate-strip'

function extract(): { title: string; text: string } | null {
  try {
    const docClone = document.cloneNode(true) as Document
    const article = new Readability(docClone).parse()
    let text: string
    if (article?.content) {
      const doc = new DOMParser().parseFromString(article.content, 'text/html')
      const blocks = [...doc.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre')]
      const joined = blocks.map((b) => b.textContent?.trim() ?? '').filter(Boolean).join('\n')
      text = stripBoilerplate(joined).trim()
    } else {
      text = (article?.textContent?.trim()) || (document.body?.innerText ?? '')
    }
    if (!text) return null
    return { title: article?.title ?? document.title, text }
  } catch {
    return null
  }
}
```
Coverage: N/A (browser-DOM glue). Justification: `DOMParser` + `querySelectorAll` are real-browser APIs not available in the node unit env; the cut LOGIC is fully unit-tested in Step 1. The wiring is covered by the existing capture e2e (`tests/e2e/*`), which still passes because extraction still yields body text.

- [ ] **Step 6: Re-run the harness WITH strip; show the number move**

Run: `npm run eval -- --strip`
Expected: `reference-snippet-rate` drops from ~1.0 to ~0.0 — citation chunks no longer exist, so the winning snippet is lead prose. S1 snippets become prose; the page-score margin widens (ranking stabilizes). Record it:
```bash
cp eval/last-scorecard.json eval/scorecard-01-strip.json
git add src/core/boilerplate-strip.ts tests/core/boilerplate-strip.test.ts src/content/capture.ts eval/scorecard-01-strip.json
git commit -m "fix(extract): strip reference/boilerplate sections before chunking (ref-snippet-rate 1.0 -> ~0)"
```

---

## Task 6: Fix 2 — low-prose chunk filter at index time (TDD)

**Files:**
- Modify: `src/core/capture-service.ts`
- Test: `tests/core/capture-service.test.ts` (add cases)

Safety net for the boilerplate Fix 1 misses (blog footers, docs API tables, GitHub rendered metadata — heading dictionaries do not catch those). Drop chunks whose `proseScore` is below a threshold AT INDEX TIME, with a guard so a genuinely table/formula-heavy page is not wiped out entirely.

- [ ] **Step 1: Write the failing test**

**Scenario:** When a `minProseScore` is set, citation-shaped chunks are dropped before storage; but if EVERY chunk of a page is below threshold (a real table-heavy page), the filter is bypassed so the page is still findable.
**Coverage:** ✅ integration (real CaptureService + real ParagraphChunker + MemoryVectorStore).

```ts
// (add to tests/core/capture-service.test.ts)
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import { CaptureService } from '../../src/core/capture-service'
import { ParagraphChunker } from '../../src/core/paragraph-chunker'

test('minProseScore drops citation-shaped chunks but keeps prose chunks', async () => {
  const store = new MemoryVectorStore()
  // chunker(maxWords=8) -> small chunks so prose vs citation separate cleanly.
  const capture = new CaptureService(new ParagraphChunker(8), store, 0.35)
  const prose = 'bacteria are ubiquitous mostly free living single celled organisms today'
  const cite = 'doi 10 1 x PMID 123 ISSN 0022 Bibcode 2003 PMC 9 S2CID 8 2019 56 417'
  const res = await capture.capture({ url: 'http://x/a', title: 'A', text: `${prose}\n${cite}` })
  expect(res.chunkCount).toBe(1) // citation chunk dropped, prose chunk kept
})

test('minProseScore is bypassed when ALL chunks are below threshold (page stays findable)', async () => {
  const store = new MemoryVectorStore()
  const capture = new CaptureService(new ParagraphChunker(8), store, 0.35)
  const allCite = 'doi 10 1 x PMID 123 ISSN 0022 Bibcode 2003 2019 56 417 PMC 9 S2CID 8'
  const res = await capture.capture({ url: 'http://x/b', title: 'B', text: allCite })
  expect(res.chunkCount).toBeGreaterThan(0) // guard: do not store ZERO chunks
})

test('default (no minProseScore) keeps every chunk (backward compatible)', async () => {
  const store = new MemoryVectorStore()
  const capture = new CaptureService(new ParagraphChunker(8), store) // no threshold arg
  const cite = 'doi 10 1 x PMID 123 ISSN 0022 Bibcode 2003 2019 56 417 PMC 9 S2CID 8'
  const res = await capture.capture({ url: 'http://x/c', title: 'C', text: cite })
  expect(res.chunkCount).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/core/capture-service.test.ts`
Expected: FAIL — `CaptureService` constructor takes only 2 args; `minProseScore` not applied.

- [ ] **Step 3: Implement**

```ts
// src/core/capture-service.ts  (modify the class)
import { proseScore } from './prose-score'
// ...
export class CaptureService {
  constructor(
    private readonly chunker: ContentChunkerPort,
    private readonly store: VectorSearchPort,
    private readonly minProseScore = 0, // 0 = keep everything (backward compatible)
  ) {}

  async capture(input: { url: string; title: string; text: string }): Promise<{ chunkCount: number }> {
    const pageId = pageIdFromUrl(input.url)
    const all = this.chunker.chunk({ pageId, text: input.text })
    if (all.length === 0) return { chunkCount: 0 }

    // Drop low-prose (citation/boilerplate) chunks — but never wipe a page out entirely:
    // if filtering would remove ALL chunks (a genuinely table/formula-heavy page), keep
    // the originals so the page stays findable.
    let chunks = all
    if (this.minProseScore > 0) {
      const kept = all.filter((c) => proseScore(c.text) >= this.minProseScore)
      chunks = kept.length > 0 ? reindex(kept, pageId) : all
    }

    const page: CapturedPage = { id: pageId, url: input.url, title: input.title, capturedAt: Date.now() }
    await this.store.upsertPage(page)
    await this.store.putChunks(pageId, chunks)
    return { chunkCount: chunks.length }
  }
}

// Chunk ids are `${pageId}#${index}` and must stay contiguous after filtering, or two
// pages' chunk ids could collide / gaps confuse hydrate. Re-number the survivors.
function reindex(chunks: { id: string; pageId: string; index: number; text: string }[], pageId: string) {
  return chunks.map((c, i) => ({ id: `${pageId}#${i}`, pageId, index: i, text: c.text }))
}
```

Wire the production threshold where the offscreen `CaptureService` is constructed (search `new CaptureService(` under `src/offscreen` / `src/background`) and pass the chosen default (recommend `0.35`; tune in Step 5). Leave other constructions (tests) at the default.

- [ ] **Step 4: Run, watch pass**

Run: `npx vitest run tests/core/capture-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run harness with prose filter; confirm non-wiki safety net**

Run: `npm run eval -- --strip --min-prose=0.35`
Expected: `reference-snippet-rate` STAYS 0 on the blog/docs/news/GitHub fixtures (the cases Fix 1's heading dictionary cannot catch). recall@5 must NOT drop (the all-dropped guard protects table-heavy pages). If recall@5 falls, LOWER the threshold (over-stripping) — recall@5 is the guardrail for this fix. Record:
```bash
cp eval/last-scorecard.json eval/scorecard-02-prose-filter.json
git add src/core/capture-service.ts tests/core/capture-service.test.ts src/offscreen eval/scorecard-02-prose-filter.json
git commit -m "fix(index): drop low-prose chunks at capture (safety net) with all-dropped guard"
```

---

## Task 7: Fix 3 — prose-preferred snippet selection (TDD)

**Files:**
- Modify: `src/core/ranking.ts` (add `chooseSnippetChunk`)
- Modify: `src/adapters/memory-vector-store.ts` (vector lane uses it)
- Modify: `src/offscreen/sqlite-worker.ts` (vector lane uses it — keep engines identical)
- Test: `tests/core/ranking.test.ts` (add cases)

Display-quality belt-and-suspenders: keep the PAGE score = max cosine (ADR 0020 invariant), but when the max-cosine chunk is non-prose, show a prose chunk that is within `epsilon` of the top cosine instead. **Per Discrepancy 1, this lives in the VECTOR LANE reduction** (where all of a page's chunks are still visible), not in `topPagesBySnippet`.

- [ ] **Step 1: Write the failing test**

**Scenario:** Among a page's chunks, the representative SNIPPET should be a prose chunk whose cosine is within epsilon of the best; only if no prose chunk is close enough does the raw max-cosine chunk win. The page's RANK score is unaffected (still max cosine).
**Coverage:** ✅ integration (pure function, real proseScore).

```ts
// (add to tests/core/ranking.test.ts)
import { chooseSnippetChunk } from '../../src/core/ranking'

const CITE = 'doi 10 1 x PMID 123 ISSN 0022 Bibcode 2003 2019 56 417 PMC 9 S2CID 8'
const PROSE = 'bacteria are ubiquitous mostly free living single celled organisms today'

test('prefers a prose chunk within epsilon of the top cosine', () => {
  const cands = [
    { id: 'p#0', cos: 0.81, text: CITE },   // max cosine, but citation
    { id: 'p#1', cos: 0.79, text: PROSE },  // within epsilon, prose -> should win the snippet
  ]
  const r = chooseSnippetChunk(cands, 0.05, 0.35)
  expect(r.id).toBe('p#1')
  expect(r.score).toBeCloseTo(0.81) // PAGE score stays the MAX cosine (ADR 0020)
})

test('keeps the max-cosine chunk when no prose chunk is within epsilon', () => {
  const cands = [
    { id: 'p#0', cos: 0.81, text: CITE },
    { id: 'p#1', cos: 0.60, text: PROSE }, // prose but too far -> not used
  ]
  const r = chooseSnippetChunk(cands, 0.05, 0.35)
  expect(r.id).toBe('p#0')
  expect(r.score).toBeCloseTo(0.81)
})

test('keeps the max-cosine chunk when it is already prose', () => {
  const cands = [
    { id: 'p#0', cos: 0.81, text: PROSE },
    { id: 'p#1', cos: 0.80, text: CITE },
  ]
  expect(chooseSnippetChunk(cands, 0.05, 0.35).id).toBe('p#0')
})
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/core/ranking.test.ts`
Expected: FAIL — `chooseSnippetChunk` not exported.

- [ ] **Step 3: Implement the pure chooser**

```ts
// src/core/ranking.ts  (ADD; topPagesBySnippet stays exactly as-is)
import { proseScore } from './prose-score'

// Given all of one page's vector candidates, pick the chunk to SHOW as the snippet while
// keeping the page's RANK score equal to the MAX cosine (ADR 0020: page score is unchanged).
// If the max-cosine chunk is non-prose, swap the snippet for a prose chunk within `epsilon`
// of the top cosine. Returns { id, score } where score is ALWAYS the page's max cosine.
export function chooseSnippetChunk(
  candidates: { id: string; cos: number; text: string }[],
  epsilon: number,
  tau: number,
): { id: string; score: number } {
  const maxCos = Math.max(...candidates.map((c) => c.cos))
  const top = candidates.reduce((a, b) => (b.cos > a.cos ? b : a))
  if (proseScore(top.text) >= tau) return { id: top.id, score: maxCos }
  const prose = candidates
    .filter((c) => c.cos >= maxCos - epsilon && proseScore(c.text) >= tau)
    .sort((a, b) => b.cos - a.cos)[0]
  return { id: (prose ?? top).id, score: maxCos }
}
```

- [ ] **Step 4: Run, watch pass**

Run: `npx vitest run tests/core/ranking.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into both engines' vector lanes**

The vector lane currently keeps only the max-cosine chunk per page (`vecBestByPage`). Change it to collect ALL of a page's chunks, then reduce with `chooseSnippetChunk`. The PAGE rank score stays the max cosine, so `vectorIds` ordering is unchanged — only the chunk id (snippet) can differ.

`src/adapters/memory-vector-store.ts` (in `search`, the vector lane):
```ts
import { topPagesBySnippet, CANDIDATE_PAGE_LIMIT, chooseSnippetChunk } from '../core/ranking'
const SNIPPET_EPSILON = 0.03
const SNIPPET_TAU = 0.35
// ...
const byPage = new Map<string, { id: string; cos: number; text: string }[]>()
for (const { chunk, vector } of this.chunks.values()) {
  if (vector === null) continue
  if (!this.pages.get(chunk.pageId)) continue
  const cos = cosineSimilarity(queryVector, vector)
  const arr = byPage.get(chunk.pageId) ?? []
  arr.push({ id: chunk.id, cos, text: chunk.text })
  byPage.set(chunk.pageId, arr)
}
const vecReduced = [...byPage.values()].map((cands) => {
  const picked = chooseSnippetChunk(cands, SNIPPET_EPSILON, SNIPPET_TAU)
  return { id: picked.id, cos: picked.score } // cos = page max cosine (rank unchanged)
})
const vectorIds = vecReduced.sort((a, b) => b.cos - a.cos).slice(0, CANDIDATE_PAGE_LIMIT).map((x) => x.id)
```

`src/offscreen/sqlite-worker.ts` (in `opSearch`, the vector lane): make the SAME change. The current callback fills `vecBestByPage` with one chunk; instead accumulate per-page arrays of `{ id, cos, text }` (the SELECT already has `c.id`, add `c.text`), then reduce with `chooseSnippetChunk(cands, 0.03, 0.35)`, keeping `cos = picked.score`. Import `chooseSnippetChunk` from `../core/ranking`. Keep the constants identical to the memory store (`0.03` / `0.35`) so the two engines stay byte-for-byte equivalent in behavior (ADR 0020).

- [ ] **Step 6: Typecheck + unit suite + harness**

Run: `npx tsc --noEmit && npm run test` -> green (existing `ranking`/`memory-vector-store` tests still pass; `topPagesBySnippet` unchanged).
Run: `npm run eval -- --strip --min-prose=0.35`
Expected: still `reference-snippet-rate=0`; on any residual case where a page's max-cosine chunk is non-prose, the snippet now swaps to prose without changing which page ranks first. Record:
```bash
cp eval/last-scorecard.json eval/scorecard-03-snippet-pref.json
git add src/core/ranking.ts src/adapters/memory-vector-store.ts src/offscreen/sqlite-worker.ts tests/core/ranking.test.ts eval/scorecard-03-snippet-pref.json
git commit -m "fix(rank): prefer a prose snippet within epsilon of top cosine (page score unchanged)"
```

---

## Task 8: Fix 4 — up-weight the lexical lane in RRF (TDD)

**Files:**
- Modify: `src/core/rrf.ts` (optional per-list weights)
- Modify: `src/adapters/memory-vector-store.ts` (pass weights)
- Modify: `src/offscreen/sqlite-worker.ts` (pass weights)
- Test: `tests/core/rrf.test.ts` (add weighted case)

S2 (`ingestion`) fix: a page that LITERALLY contains the query term (lexical lane) can still rank below an irrelevant high-cosine reference chunk, because the vector and lexical lanes get EQUAL RRF weight. Give the lexical lane a configurable weight. Pure-semantic S4 queries produce NO lexical candidates, so this is safe for them by construction.

- [ ] **Step 1: Write the failing test**

**Scenario:** With equal weights, a page that is rank-1 in only the vector lane ties/beats a page rank-1 in only the lexical lane. With the lexical lane up-weighted, the lexical-only page wins — and a default call (no weights) is identical to today's behavior.
**Coverage:** ✅ integration (pure RRF arithmetic).

```ts
// (add to tests/core/rrf.test.ts)
import { rrfFuse } from '../../src/core/rrf'

test('default weights are unchanged (backward compatible)', () => {
  // 'a' is rank-1 in both lists -> still the top with no weights.
  expect(rrfFuse([['a', 'b'], ['a']])[0].id).toBe('a')
})

test('up-weighting the lexical lane lifts a lexical-only match above a vector-only match', () => {
  const vectorIds = ['v'] // v: vector rank-1, absent from lexical
  const lexicalIds = ['x'] // x: lexical rank-1, absent from vector
  // Equal weight -> tie (both 1/(60+1)); insertion order keeps 'v' first.
  expect(rrfFuse([vectorIds, lexicalIds])[0].id).toBe('v')
  // Lexical weight 2 -> 'x' gets 2/61 > 'v' 1/61.
  expect(rrfFuse([vectorIds, lexicalIds], 60, [1, 2])[0].id).toBe('x')
})
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/core/rrf.test.ts`
Expected: FAIL — `rrfFuse` ignores a 3rd arg.

- [ ] **Step 3: Implement weighted fusion**

```ts
// src/core/rrf.ts
export interface FusedHit { id: string; score: number }

// Reciprocal Rank Fusion with OPTIONAL per-list weights. score(id) = sum w_list/(k+rank).
// weights defaults to all-1 -> identical to the original behavior. Up-weighting the
// lexical list lets an exact-term page beat an irrelevant high-cosine vector match
// (Fix 4) without touching pure-semantic queries (which have an EMPTY lexical list,
// so its weight is moot).
export function rrfFuse(lists: string[][], k = 60, weights?: number[]): FusedHit[] {
  const score = new Map<string, number>()
  lists.forEach((list, li) => {
    const w = weights?.[li] ?? 1
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + w / (k + i + 1))
    })
  })
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score)
}
```

- [ ] **Step 4: Run, watch pass**

Run: `npx vitest run tests/core/rrf.test.ts`
Expected: PASS (existing rrf tests + 2 new).

- [ ] **Step 5: Wire the weight in both engines**

Add a shared constant and pass it. In `src/core/ranking.ts` (a natural home next to `CANDIDATE_PAGE_LIMIT`) add:
```ts
// Lexical lane weight in RRF fusion. >1 favors exact-term (FTS) matches over pure-vector
// matches. Tuned on the golden set (S2 must pass) WITHOUT regressing S4 (pure-semantic,
// no lexical candidates -> weight has no effect there).
export const LEXICAL_RRF_WEIGHT = 2
```
`src/adapters/memory-vector-store.ts`:
```ts
import { topPagesBySnippet, CANDIDATE_PAGE_LIMIT, chooseSnippetChunk, LEXICAL_RRF_WEIGHT } from '../core/ranking'
// ...
const fused = rrfFuse([vectorIds, lexicalIds], 60, [1, LEXICAL_RRF_WEIGHT])
```
`src/offscreen/sqlite-worker.ts`:
```ts
import { topPagesBySnippet, CANDIDATE_PAGE_LIMIT, chooseSnippetChunk, LEXICAL_RRF_WEIGHT } from '../core/ranking'
// ...
const fused = rrfFuse([vectorIds, lexicalIds], 60, [1, LEXICAL_RRF_WEIGHT])
```

- [ ] **Step 6: Tune on the harness — S2 passes, S4 holds**

Run: `npm run eval -- --strip --min-prose=0.35`
Expected: S2 (`ingestion`) now `p1=1` (the ingestion PR outranks the Protein reference chunk via the up-weighted lexical lane). S4 (`hormone that ruins sleep`) UNCHANGED (`p1=1`) — it has no lexical candidates, so the weight cannot affect it. If S2 still fails, raise `LEXICAL_RRF_WEIGHT` incrementally; if any pure-semantic query regresses, you have over-weighted — back off. Record:
```bash
cp eval/last-scorecard.json eval/scorecard-04-lexical-weight.json
git add src/core/rrf.ts src/core/ranking.ts src/adapters/memory-vector-store.ts src/offscreen/sqlite-worker.ts tests/core/rrf.test.ts eval/scorecard-04-lexical-weight.json
git commit -m "fix(rank): up-weight lexical lane in RRF so exact-term matches win (S2)"
```

---

## Task 9: CI gate on a thresholded subset

**Files:**
- Modify: `package.json` (add `eval:ci`)
- Create: `eval/ci-golden.json` (small subset, one per scenario)

Lock the regression out: a tiny subset with hard thresholds so any future chunker/extraction change that brings the bug back fails CI.

**Coverage:** N/A (CI wiring over the already-tested harness).

- [ ] **Step 1: Subset + thresholded runner**

Create `eval/ci-golden.json` with one query per scenario (S1 `bacteria`, S2 `ingestion`, S3 `광합성 명반응`, S4 `hormone that ruins sleep`, S5 `what is a protein`). Add an exit-code check to `run.mjs` triggered by a `--ci` flag (reads `eval/ci-golden.json` instead of `golden.json`, then):
```js
// at the end of run.mjs, when --ci:
if (args.includes('--ci')) {
  const fail = []
  if (refRate !== 0) fail.push(`reference-snippet-rate ${refRate} != 0`)
  if (agg.precisionAt1 < 0.8) fail.push(`p@1 ${agg.precisionAt1} < 0.8`)
  const s2 = rows.find((r) => r.scenario === 'S2')
  if (!s2 || s2.p1 !== 1) fail.push('S2 (exact-term) did not pass')
  if (fail.length) { console.error('EVAL CI FAILED:\n' + fail.join('\n')); process.exit(1) }
  console.log('EVAL CI PASSED')
}
```
Add script: `"eval:ci": "npm run eval:fetch-model && node eval/run.mjs --ci --strip --min-prose=0.35"`.

- [ ] **Step 2: Run the gate**

Run: `npm run eval:ci`
Expected: prints `EVAL CI PASSED`, exit 0. (Thresholds: `reference-snippet-rate == 0`, `p@1 >= 0.8`, S2 passes.)

- [ ] **Step 3: Wire into CI**

In the CI workflow, add a step that caches `eval/.cache` + `public/models` (keyed on the pinned model SHA from `scripts/fetch-model.mjs`) and runs `npm run eval:ci`. Keep it OUT of `npm run test` (slow). Document in the workflow comment that the full `npm run eval` set is nightly/manual.

- [ ] **Step 4: Commit**

```bash
git add package.json eval/ci-golden.json eval/run.mjs .github
git commit -m "ci(eval): gate on reference-snippet-rate==0, p@1>=0.8, S2 passes"
```

---

## How to grow the golden set (the maintenance pattern)

The corpus is meant to GROW as new failures are found. To add a page or query:

1. **Add a page:** capture it (or run `node eval/lib/extract-fixture.mjs <url> <id>`), save `eval/fixtures/<id>.txt` (references KEPT, block-joined), then append one row to `eval/manifest.json`: `{ id: pageIdFromUrl(url), file, url, source, lang, note }`. `id` MUST equal `pageIdFromUrl(url)` or `expectTopPageIds` will never match.
2. **Add a query/scenario:** append to `eval/golden.json`: `{ scenario, query, expectTopPageIds, expectProseSnippet }`. Reuse an existing `scenario` tag (S1-S5) or add a new one. The query text may be any language (data file, not test source).
3. **Re-run** `npm run eval` to see the new row in the scorecard. If it exposes a NEW failure, that is a finding — fix it, then add the query to `eval/ci-golden.json` so it is guarded forever.

---

## Self-Review

**Spec coverage:**
- Empirical scenario-driven golden set (corpus -> discover -> codify -> fix -> measure): Tasks 3, 4, 5-8. ✅
- Balanced/general corpus incl. Korean + the real ingestion GitHub case, with source URLs: Task 3. ✅
- Fixtures = pre-extracted text + manifest (justified): Task 3 + Decisions. ✅
- Real-model-in-Node at q8, local model dir, not recorded vectors: Task 4 Step 1 + Decisions. ✅
- `npm run eval` separate from `npm run test`; CI subset gated: Task 4 Step 4, Task 9. ✅
- Scenarios S1-S5: Task 3 Step 4 (`golden.json`). ✅
- Metrics p@1 / recall@5 / MRR / reference-snippet-rate: Task 1 + Task 4 scorecard. ✅
- Fix 1 boilerplate strip (pure + extraction wiring): Task 5. ✅
- Fix 2 prose filter (pure proseScore + index-time, all-dropped guard): Tasks 2 + 6. ✅
- Fix 3 prose-preferred snippet (page score unchanged): Task 7. ✅
- Fix 4 lexical RRF weight (fusion math unit-tested, tuned without regressing S4): Task 8. ✅
- Sequencing: harness + baseline FIRST (Task 4), then fixes one at a time with before/after scorecards (Tasks 5-8). ✅
- How to add a page/query: dedicated section above. ✅

**Type/name consistency:** `proseScore` (Task 2) consumed by `eval-metrics` harness usage (Task 4), `CaptureService.minProseScore` (Task 6), `chooseSnippetChunk` (Task 7). `chooseSnippetChunk(candidates, epsilon, tau)` signature identical in `ranking.ts`, `memory-vector-store.ts`, `sqlite-worker.ts`. `rrfFuse(lists, k, weights)` signature identical in `rrf.ts` and both call sites. `LEXICAL_RRF_WEIGHT` exported once from `ranking.ts`, imported by both engines. `pageIdFromUrl` used to derive manifest `id`. All match.

**Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step shows complete code. The two corpus placeholders (`OWNER/REPO/pull/NNN`) are intentional — the implementer fills the REAL ingestion PR url they capture; flagged inline as "REAL failing case".

**Two engines in lockstep:** Fixes 3 and 4 modify BOTH `memory-vector-store.ts` and `sqlite-worker.ts` with identical constants (epsilon 0.03, tau 0.35, lexical weight 2) so the offline harness (memory store) and production (worker) stay semantically identical per ADR 0020. The harness only exercises the memory store — Task 7/8 Step 6 runs `npm run test` + `tsc` to keep the worker honest, but the worker's vector-lane change is NOT directly eval-covered (it has no node FTS5). This is the same real-path gap the analysis (5.2) accepts: the worker FTS5 lexical lane is covered by the existing e2e, not the node harness.

## Tradeoffs

- **Corpus maintenance.** ~25-35 text fixtures must be regenerated if Readability's extraction or the block-join formatting changes (rare). Text fixtures (not HTML) keep this cheap and the diff readable. The "how to grow" pattern keeps additions a 2-file edit.
- **q8 determinism in CI.** The harness runs q8 to match production; q8 quantization is deterministic on CPU for fixed inputs, but a transformers.js version bump could shift scores at the 3rd decimal. Mitigation: the model SHA is pinned (`scripts/fetch-model.mjs`); pin the `@huggingface/transformers` version too, and the CI thresholds (`refRate==0`, `p@1>=0.8`) have margin so a tiny score drift does not flip the gate.
- **Over-stripping risk (Fix 1 + Fix 2).** Aggressive boilerplate/prose removal could delete real body text. Guards: Fix 1 only cuts a STAND-ALONE heading line in the document tail (>=40% down); Fix 2 bypasses the filter when it would drop ALL chunks. recall@5 is the explicit guardrail — Task 6 Step 5 says lower the threshold if recall@5 falls.
- **Cross-lingual modest cosine (S3).** Korean-query -> English-page cosines sit in the mid 0.75-0.81 band (per the analysis), so margins are thin and q8 can wobble rank. The golden set treats S3 as recall@5 (not strict p@1) tolerant, and Fix 1 helps most here by removing the citation chunks that were winning the thin races.
- **Worker not directly eval-covered.** As noted in Self-Review, the harness runs the memory store, not the sqlite worker's FTS5 lane. Accepted (matches the analysis); the worker is covered by existing e2e and the lockstep constants.
- **Snippet swap candidate visibility (Fix 3).** Because the vector lane now keeps per-page chunk arrays (not one chunk), the worker's full-scan vector lane holds slightly more in memory per search. For v1 corpus sizes this is negligible; if profiles grow large, cap the per-page array to the top-N-by-cosine before `chooseSnippetChunk` (the prose swap only needs chunks within epsilon of the max anyway).
```

# Search Priority + Document-Level Results + Pico UI (revised per adversarial spec review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Every code change is TDD: failing test FIRST, watched fail, then implementation. Steps use checkbox (`- [ ]`).

**Goal:** Three independent popup-search improvements:
1. **Kill the ~10s search stall** - an interactive query must not wait behind background indexing (priority inversion).
2. **Document-level results** - one card per PAGE (its best-matching chunk as the snippet), not one per chunk.
3. **Pretty popup** via Pico (CSS-only).

**This revision** reconciles the original spec with the code as it actually is now: HYBRID SEARCH (RRF fusion) is already merged, and INDEXING RESILIENCE (drain retry + injected `sleep`, ping re-drain) is already merged. The original spec was drafted before both and was stale; every fix below comes from the adversarial spec review.

**Tech Stack:** TypeScript, Vite+CRXJS, Preact, `@huggingface/transformers`, `@sqlite.org/sqlite-wasm` (OPFS), `@picocss/pico` (CSS only, new), Vitest, Playwright.

**Current baseline (verify before starting):** `npx vitest run` = 17 files / 98 tests green. (The original spec's "16/91" was stale.)

---

## Critical reconciliation notes (read first)

- **Both stores already fuse.** `MemoryVectorStore.search` and worker `opSearch` END with `rrfFuse([vectorIds, lexicalIds]).slice(0, k)` then hydrate to `RankedResult[]`. There is NO `scored.sort().slice(k)` tail anywhere - the original spec's find-replace target does not exist. Document-level collapse must run over the FULL fused+hydrated ranking and slice to k PAGES (collapsing AFTER a slice-to-k-chunks would yield FEWER than k pages).
- **`IndexingService` constructor is already 5 params** (`store, embedder, batch=32, maxRetries=3, sleep=...`). Change ONLY the `batch = 32` default token to `8`; do not rewrite the signature.
- **The GPU-gentle yield MUST survive.** Today the 120ms inter-sub-batch yield lives inside `runEmbed`; at `batch=8` an `embed()` call is a single sub-batch, so that yield never fires and indexing would fire 8-text GPU submissions back-to-back - the page gets very slow. So this plan MOVES the gentle gap to a yield between `drain` iterations (reusing the already-injected `sleep`). This keeps the page responsive AND lets a query jump in during the gap.
- **Results markup `<li> -> <article>` breaks 7 e2e specs, not 1.** All must be updated (Task 3).

---

## File Map

| File | Action | Responsibility after change |
|------|--------|-----------------------------|
| `src/offscreen/webgpu-embedder.ts` | Modify | Two-lane single-flight scheduler: a `query` jumps ahead of queued `passage` work. `runEmbed` (batching/prefix/yield) untouched. |
| `src/core/indexing-service.ts` | Modify | `batch` default `32 -> 8`; add a GPU-gentle `await this.sleep(YIELD_MS)` between drain iterations. |
| `src/core/ranking.ts` | Create | Pure `topPagesBySnippet(results, k)`: best chunk per page, rank pages, take top-k. |
| `src/adapters/memory-vector-store.ts` | Modify | `search`: fuse FULL list -> hydrate -> `topPagesBySnippet(results, k)` (drop the `.slice(0,k)` on the fused ids). |
| `src/offscreen/sqlite-worker.ts` | Modify | `opSearch`: fuse FULL list -> hydrate -> `topPagesBySnippet(results, k)` (drop the `.slice(0,k)` before hydrate). |
| `src/ui/popup/main.tsx` | Modify | Import Pico classless CSS + `popup.css`. |
| `src/ui/popup/popup.css` | Create | Compact 360px overrides + result-card styles. |
| `src/ui/popup/index.html` | Modify | Minimal; keep `#app` + module script + an explicit `width:360px` (avoid flash). |
| `src/ui/popup/App.tsx` | Modify | Results render as `<article>` cards (title link + snippet + footer). Handlers unchanged. |
| `tests/core/webgpu-embedder.test.ts` | Modify | Add priority-inversion test (RED first). |
| `tests/core/ranking.test.ts` | Create | Tests for `topPagesBySnippet`. |
| `tests/core/memory-vector-store.test.ts` | Modify | Per-chunk -> per-page ranking; add collapse test. |
| `tests/e2e/recall-flow.spec.ts` | Modify | `li -> article`; count `2 -> 1`; keep "both chunks indexed" guard via per-query snippet flip. |
| `tests/e2e/persistence.spec.ts` | Modify | `li -> article`; **count `2 -> 1` (lines 75 and 113)**. |
| `tests/e2e/hybrid-search.spec.ts` | Modify | `li -> article` (3 sites). |
| `tests/e2e/forget-history.spec.ts` | Modify | `li -> article` (incl. the `toHaveCount(0)` lines - else false-green). |
| `tests/e2e/user-controls.spec.ts` | Modify | `li -> article` (incl. the `toHaveCount(0)` line - else false-green). |
| `tests/e2e/spa-navigation.spec.ts` | Modify | `li -> article` (3 sites). |
| `tests/e2e/auto-capture.spec.ts` | Modify | `li -> article`. |
| `package.json` | Modify | Add `@picocss/pico`. |

**NOT touched:** `src/core/recall-service.ts` (already `embed(query,'query') -> store.search`; the `'query'` kind reaches the embedder lane - verified), `src/offscreen/offscreen-rpc.ts`, `src/background/index.ts`, `src/content/*`.

---

## Task 1: Query-priority embedder + batch=8 + preserved GPU-gentle yield

The embedder runs one inference at a time and cannot interrupt the batch already running. Fix = (A) a waiting `query` overtakes any not-yet-started `passage` work, (B) passage batches small so the one in-flight batch a query may wait on is short, (C) keep a GPU-gentle gap so the foreground page stays smooth.

**Files:** Modify `tests/core/webgpu-embedder.test.ts` (test first), `src/offscreen/webgpu-embedder.ts`, `src/core/indexing-service.ts`.

- [ ] **Step 1 (RED): priority-inversion test**

Add to `tests/core/webgpu-embedder.test.ts` (it already has a fake `PipelineFactory` recording call order in `fake.calls`):

```typescript
// Scenario: a background indexing batch is mid-flight when the user hits Enter on a
// search. The interactive query must NOT wait behind queued passage batches (the ~10s
// "search hangs" bug); it jumps ahead of any passage work not yet started.
// Coverage: integration (fake records execution order through the real queue).
test('priority: a query embed jumps ahead of queued passage embeds', async () => {
  const fake = makeFake()
  const embedder = new WebGpuEmbedder(fake.factory)
  await embedder.ensureLoaded()
  fake.calls.length = 0 // drop the warmup call

  const p1 = embedder.embed(['p1'], 'passage') // commits first, holds the single slot
  const p2 = embedder.embed(['p2'], 'passage') // queues behind p1
  const q = embedder.embed(['q1'], 'query') // arrives while p1 in flight -> overtakes p2
  await Promise.all([p1, p2, q])

  expect(fake.calls.flat()).toEqual(['passage: p1', 'query: q1', 'passage: p2'])
})
```

Run `npx vitest run tests/core/webgpu-embedder.test.ts` -> MUST fail with order `['passage: p1','passage: p2','query: q1']` (today's FIFO starves the query).

- [ ] **Step 2 (GREEN): two-lane scheduler (`webgpu-embedder.ts`)**

Add the task type near the top:
```typescript
interface EmbedTask {
  texts: string[]
  kind: 'query' | 'passage'
  resolve: (vecs: number[][]) => void
  reject: (err: unknown) => void
}
```
Replace the single-queue field with two lanes + a pump flag:
```typescript
  // Single-flight, two-lane scheduler: ONNX never gets two overlapping inputs, AND an
  // interactive query never waits behind background passage work. queries -> highQ,
  // passages -> lowQ; the pump always drains highQ first. The in-flight runEmbed is never
  // interrupted (ONNX can't be), so passage batches are kept small (IndexingService).
  private highQ: EmbedTask[] = []
  private lowQ: EmbedTask[] = []
  private pumping = false
```
Replace `embed()` with enqueue + pump (keep `runEmbed` exactly as-is - it owns batching/prefix/the internal yield):
```typescript
  embed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]> {
    return new Promise<number[][]>((resolve, reject) => {
      ;(kind === 'query' ? this.highQ : this.lowQ).push({ texts, kind, resolve, reject })
      this.pump()
    })
  }

  // Single-flight: one runEmbed at a time. Always prefer a waiting query over passages.
  // Checks `pumping` BEFORE shifting (never drops a task) and always re-pumps in .finally
  // (a failed batch never stalls the lane).
  private pump(): void {
    if (this.pumping) return
    const next = this.highQ.shift() ?? this.lowQ.shift()
    if (!next) return
    this.pumping = true
    this.runEmbed(next.texts, next.kind).then(next.resolve, next.reject).finally(() => {
      this.pumping = false
      this.pump()
    })
  }
```
INVARIANTS the existing tests pin (must stay green): single-flight no-overlap (`maxActive===1`), batching `[8,8,4]`, `query:`/`passage:` prefixes, poisoned-pipe retry. Keeping `runEmbed` untouched preserves all four; the reorder lives only in `embed`/`pump`.

- [ ] **Step 3 (GREEN): batch=8 + GPU-gentle drain yield (`indexing-service.ts`)**

The constructor already carries `maxRetries`/`sleep` (from the resilience change). Change ONLY the `batch` default:
```typescript
    // Small batches bound the worst-case wait an interactive query pays: the embedder runs
    // a 'query' ahead of queued passages but cannot interrupt the batch already in flight,
    // so a smaller batch = a shorter query stall.
    private readonly batch = 8,
```
Add a module-level constant and a yield between drain iterations so the foreground page stays smooth at batch=8 (the embedder's own inter-sub-batch yield no longer fires for single 8-text batches). Reuse the injected `sleep` (tests inject a no-op, so they stay instant):
```typescript
// GPU-gentle gap between indexing batches: lets the foreground page render AND lets an
// interactive query (which the embedder runs ahead of queued passages) start during the
// gap. Mirrors the embedder's own 120ms inter-batch yield, which goes dormant at batch=8.
const YIELD_MS = 120
```
In `drain`, after a successful batch (`onBatch?.(...)`), before looping, add:
```typescript
        await this.sleep(YIELD_MS)
```
(Place it after `onBatch?.(pending.length)` and before the next loop iteration. The single-flight `running` guard, the `embedBatchWithRetry` retry, and the graceful `break` on persistent failure all stay exactly as the resilience change left them.)

- [ ] **Step 4: verify**

`npx vitest run tests/core/webgpu-embedder.test.ts tests/core/indexing-service.test.ts` -> new priority test passes; existing single-flight/batching/prefix/poisoned-pipe and all indexing-service (retry/graceful-stop) tests stay green (the injected no-op `sleep` keeps the new yield instant in tests).

---

## Task 2: Document-level results over the hybrid pipeline

Collapse chunk-level results to top-k PAGES, each represented by its best-scoring chunk (the snippet). Because both stores now FUSE (RRF) and the fused score is per-query, the per-page best chunk is automatically the query-best snippet. Stays pure semantic ranking (ADR 0003): the page's score = its max chunk score, no recency boost, no per-page spreading.

The dedup MUST run over the FULL fused ranking BEFORE taking k (otherwise k chunks may span fewer than k pages).

**Files:** Create `tests/core/ranking.test.ts` (test first), `src/core/ranking.ts`; Modify `src/adapters/memory-vector-store.ts`, `src/offscreen/sqlite-worker.ts`, `tests/core/memory-vector-store.test.ts`, and the e2e in Task 3 Step 6.

- [ ] **Step 1 (RED): `tests/core/ranking.test.ts`**

```typescript
import { topPagesBySnippet } from '../../src/core/ranking'
import type { RankedResult, CapturedPage } from '../../src/core/model'

const page = (id: string): CapturedPage => ({ id, url: `http://x/${id}`, title: id.toUpperCase(), capturedAt: 1 })
const r = (pageId: string, idx: number, score: number): RankedResult => ({
  chunk: { id: `${pageId}#${idx}`, pageId, index: idx, text: `${pageId} chunk ${idx}` },
  page: page(pageId),
  score,
})

// Scenario: one page matches on several chunks; results list that page ONCE with its
// best chunk as the snippet, not flood the list with near-duplicate chunks.
// Coverage: integration (pure ranking over the real RankedResult shape).
test('collapses a page to one result carrying its best-scoring chunk', () => {
  const out = topPagesBySnippet([r('p1', 0, 0.4), r('p1', 1, 0.9), r('p2', 0, 0.5)], 5)
  expect(out.map((x) => x.page.id)).toEqual(['p1', 'p2']) // p1 wins via its 0.9 chunk
  expect(out[0].chunk.id).toBe('p1#1') // snippet = the best chunk
})

// Scenario: k caps distinct PAGES, even when one page contributes several top chunks.
// Coverage: integration (pure ranking).
test('k caps distinct pages, not chunks', () => {
  const out = topPagesBySnippet([r('p1', 0, 0.9), r('p1', 1, 0.85), r('p2', 0, 0.8), r('p3', 0, 0.7)], 2)
  expect(out.map((x) => x.page.id)).toEqual(['p1', 'p2'])
})
```
To see a clean assertion-RED (not a missing-module error), stub `src/core/ranking.ts` first as `export function topPagesBySnippet(results, k) { return results.slice(0, k) }`, run, watch both fail.

- [ ] **Step 2 (GREEN): `src/core/ranking.ts`**

```typescript
import type { RankedResult } from './model'

// Collapse chunk-level results to document-level: keep, per page, the single highest-
// scoring chunk as that page's representative snippet, then rank pages by that best score
// and return the top k. One busy page shows up once (with its strongest match) instead of
// flooding the list with near-duplicate chunks. Pure semantic ranking - the page score is
// its max chunk score, no recency boost (ADR 0003), no spreading across the page's chunks.
export function topPagesBySnippet(results: RankedResult[], k: number): RankedResult[] {
  const bestByPage = new Map<string, RankedResult>()
  for (const r of results) {
    const cur = bestByPage.get(r.page.id)
    if (!cur || r.score > cur.score) bestByPage.set(r.page.id, r)
  }
  return [...bestByPage.values()].sort((a, b) => b.score - a.score).slice(0, k)
}
```

- [ ] **Step 3 (GREEN): wire `MemoryVectorStore.search`**

In `src/adapters/memory-vector-store.ts` add `import { topPagesBySnippet } from '../core/ranking'`. The method currently does `const fused = rrfFuse([vectorIds, lexicalIds]).slice(0, k)` then maps to `RankedResult[]`. Change to: fuse WITHOUT slicing, hydrate the FULL fused list to `RankedResult[]`, then `return topPagesBySnippet(results, k)`. Concretely: drop the `.slice(0, k)`; keep building `RankedResult[]` from every fused id; replace the final `return results` with `return topPagesBySnippet(results, k)`.

- [ ] **Step 4 (GREEN): wire worker `opSearch`**

In `src/offscreen/sqlite-worker.ts` add `import { topPagesBySnippet } from '../core/ranking'` (worker already imports `../core/*`). `opSearch` currently ends:
```typescript
  const fused = rrfFuse([vectorIds, lexicalIds]).slice(0, k)
  return fused.map((hit) => hydrate(db, hit.id, hit.score)).filter(Boolean) as RankedResult[]
```
Change to fuse without slicing, hydrate the full fused list, then collapse to k pages:
```typescript
  const fused = rrfFuse([vectorIds, lexicalIds]) // full ranking; bounded by the N=50 candidate caps
  const hydrated = fused.map((hit) => hydrate(db, hit.id, hit.score)).filter(Boolean) as RankedResult[]
  return topPagesBySnippet(hydrated, k)
```
(The fused list is bounded by the per-lane `N = 50` candidate caps, so hydrating all of it is cheap.)

- [ ] **Step 5: update `tests/core/memory-vector-store.test.ts`**

The old "ranks the nearest chunk first" test seeded two chunks of the SAME page and asserted two results (per-chunk behavior we removed). Replace with a two-PAGE test + a collapse test:

```typescript
// Scenario: document-level results - the nearest page ranks first, represented by its
// best chunk; two pages -> two results.
// Coverage: integration (real MemoryVectorStore + topPagesBySnippet, hybrid path).
test('ranks the nearest page first, each carrying its best chunk', async () => {
  const store = new MemoryVectorStore()
  const pageB: CapturedPage = { id: 'p2', url: 'http://y', title: 'Y', capturedAt: 1 }
  await store.upsertPage(page)
  await store.upsertPage(pageB)
  await store.putChunks('p1', [{ id: 'p1#0', pageId: 'p1', index: 0, text: 'near' }])
  await store.putChunks('p2', [{ id: 'p2#0', pageId: 'p2', index: 0, text: 'far' }])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  await store.setVector('p2#0', new Float32Array([0, 1]))

  const results = await store.search(new Float32Array([0.9, 0.1]), '', 2)
  expect(results[0].page.id).toBe('p1')
  expect(results[0].chunk.id).toBe('p1#0')
  expect(results[0].score).toBeGreaterThan(results[1].score)
})

// Scenario: many chunks of one page collapse to a single result, snippet = best chunk.
// Coverage: integration (real MemoryVectorStore + topPagesBySnippet).
test('collapses many chunks of one page into a single result (its best chunk)', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.putChunks('p1', [chunkA, chunkB])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  await store.setVector('p1#1', new Float32Array([0, 1]))

  const results = await store.search(new Float32Array([0.1, 0.9]), '', 5)
  expect(results.length).toBe(1)
  expect(results[0].chunk.id).toBe('p1#1') // nearest chunk is the snippet
})
```
NOTE the 3-arg `search(vector, '', k)` signature (hybrid added `queryText`). The other tests in this file (`respects k`, `excludes pending`, `putChunks replaces`) stay green - collapsing one page's chunks to one result doesn't change their single-result expectations; just confirm any that asserted a multi-chunk-from-one-page count are updated.

---

## Task 3: Pretty popup with Pico (CSS-only) + e2e updates for the new markup

Pico styles plain semantic HTML with no JS runtime. Results become `<article>` cards, which means EVERY e2e that locates results via `popup.locator('li')` must move to `popup.locator('article')` - 7 specs, not 1.

**Files:** Modify `package.json`, `src/ui/popup/main.tsx`, `src/ui/popup/index.html`, `src/ui/popup/App.tsx`; Create `src/ui/popup/popup.css`; Modify the 7 e2e specs.

- [ ] **Step 1: install Pico** - `npm install @picocss/pico@^2`

- [ ] **Step 2: `main.tsx`** - import the LOCAL package CSS (never a CDN url - that would violate CSP `style-src`/`connect-src`):
```typescript
import { render } from 'preact'
import '@picocss/pico/css/pico.classless.min.css'
import './popup.css'
import { App } from './App'
render(<App />, document.getElementById('app')!)
```

- [ ] **Step 3: `src/ui/popup/popup.css`** (compact for 360px; cards):
```css
/* Compact overrides for the 360px extension popup. Pico defaults target full pages, so
   tighten typography/spacing. Dark mode is free via prefers-color-scheme. */
:root {
  font-size: 87.5%;
  --pico-spacing: 0.6rem;
  --pico-block-spacing-vertical: 0.6rem;
  --pico-form-element-spacing-vertical: 0.45rem;
  --pico-border-radius: 0.5rem;
  --pico-font-family: system-ui, -apple-system, sans-serif;
}
body { width: 360px; }
main.container { padding: 0.75rem; }
.row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.row > button { flex: 1 1 auto; width: auto; margin: 0; }
article { margin: 0.5rem 0; padding: 0.6rem 0.75rem; }
article > a { text-decoration: none; font-weight: 600; }
article > p { margin: 0.3rem 0 0; font-size: 0.92em; color: var(--pico-color); }
article > footer { margin-top: 0.35rem; padding: 0; background: none; border: none; }
```

- [ ] **Step 4: `index.html`** - minimal, but KEEP the mount node, the module script, AND an explicit width so the popup doesn't size-to-content / flash before CSS loads:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Recall</title></head>
  <body style="width: 360px">
    <div id="app"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: `App.tsx`** - keep ALL hooks/handlers byte-for-byte (`search`, `capture`, `denyHost`, `removeDeny`, `forgetHost`, `togglePause`) and the exact strings the e2e depend on: button `Capture this page`, input `placeholder="recall..."`, status values (`captured`, `indexing... N done`, `indexed`, `Paused - nothing is being saved`, `not saved: this site is on the no-remember list`, `won't remember ...`, `Forgot everything from ...`). Only `renderModelStatus()` and the returned JSX change. Add a footer host helper:
```typescript
function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}
```
Results render as `<article>` cards (this is the markup the e2e now target):
```tsx
      {results.map((r) => (
        <article key={r.chunk.id}>
          <a href={r.page.url} target="_blank" rel="noopener noreferrer">{r.page.title}</a>
          <p>{r.chunk.text}</p>
          <footer><small>{hostOf(r.page.url)} &middot; {r.score.toFixed(2)}</small></footer>
        </article>
      ))}
```
Use a `<main class="container">`, Pico `<progress>` for model-loading, a `role="switch"` pause toggle, a `.row` of the deny/forget buttons, a `<details>` no-remember list, the capture button, an `<input type="search" placeholder="recall...">`. Keep the `searching` / `no results` indicators.

- [ ] **Step 6: update ALL 7 e2e specs to the `<article>` + document-level contract**

Mechanical `popup.locator('li')` -> `popup.locator('article')` everywhere, PLUS the two semantic changes (count collapse + false-green audit):

- `tests/e2e/recall-flow.spec.ts` - `li -> article`; the single article fixture is ONE page (2 chunks), so **count `2 -> 1`**. KEEP the "both chunks indexed" guard: Search 1 (`hormone that ruins sleep`) -> first `article` contains `Cortisol`; Search 2 (`double entry bookkeeping tax`) -> first `article` contains `bookkeeping` and NOT `Cortisol`. The snippet flipping between the two queries IS the proof both chunks indexed (the page title `Sleep Science and Accounting` contains neither word, so it can't mask either assertion).
- `tests/e2e/persistence.spec.ts` - `li -> article`; **`toHaveCount(2) -> toHaveCount(1)` at BOTH sites (session 1 ~line 75, session 2 ~line 113)** (same one-page/2-chunk fixture).
- `tests/e2e/hybrid-search.spec.ts` - `li -> article` (the 3 `.first()` content asserts: Zylophin/Cortisol/Photosynthesis). Counts are already `.first()` over 4 distinct pages - fine.
- `tests/e2e/forget-history.spec.ts` - `li -> article` at the recall asserts AND the post-forget `toHaveCount(0)` lines (the privacy "content gone" checks). If left as `li`, `toHaveCount(0)` would pass for the WRONG reason (no `li` exists) and stop testing anything.
- `tests/e2e/user-controls.spec.ts` - `li -> article`, including the paused `toHaveCount(0)` line (same false-green risk).
- `tests/e2e/spa-navigation.spec.ts` - `li -> article` (the 3 `.first()` asserts).
- `tests/e2e/auto-capture.spec.ts` - `li -> article` (the `.first()` assert).

---

## Verification (run all)

- [ ] `npx vitest run` - full unit suite green (was 17 files / 98; +priority +ranking tests, memory-store test reshaped).
- [ ] `npx tsc --noEmit` - clean. `rg "chrome" src/core` - empty (ranking.ts is pure).
- [ ] `npm run build` - exit 0; confirm Pico CSS is bundled into `dist-ext/assets/*.css` (~10 KB gzip) and inlined (no runtime fetch -> CSP `connect-src 'self'` safe).
- [ ] `npx playwright test` - ALL e2e green (the config runs serial workers:1 + retries:1). The 7 updated specs must pass; a hard failure (not a single retry-absorbed flake) means a missed locator/count.
- [ ] Eyeball: load `dist-ext/`, open popup, search - one card per page, snippet flips per query, dark mode works, width stable (no flash).

---

## Self-Review Checklist

- [ ] Priority test watched FAIL on the old FIFO before the two-lane fix.
- [ ] `pump()` checks `pumping` before shifting (no dropped task) and re-pumps in `.finally` (no stall); existing `maxActive===1` single-flight test still green.
- [ ] **GPU-gentle yield preserved**: the drain-loop `await this.sleep(YIELD_MS)` keeps the foreground smooth at batch=8 (the embedder's internal yield goes dormant for single 8-text batches).
- [ ] `topPagesBySnippet` dedups over the FULL fused+hydrated ranking BEFORE slicing to k PAGES (NOT after a slice-to-k-chunks), shared by both stores; no `scored.sort().slice` (it never existed post-hybrid).
- [ ] Document-level respects ADR 0003 (page score = max chunk score; no recency; no per-page spread).
- [ ] App.tsx handlers + e2e-relied strings unchanged; only markup/styles changed.
- [ ] **All 7 e2e specs** updated to `article`; persistence counts `2 -> 1`; every `toHaveCount(0)` retargeted to `article` (no false-green).
- [ ] Pico is local CSS import (no CDN), no JS runtime; `index.html` keeps `#app`, the module script, and an explicit width.

---

## Known Constraints (honest)

- **ONNX can't be interrupted mid-inference.** The query overtakes only NOT-yet-started work; it still waits out the one in-flight batch - which is why batch=8 (short in-flight unit) and the priority lane work together.
- **"No results" is only SHORTENED, not eliminated.** `opSearch` filters `WHERE c.vector IS NOT NULL`, so a freshly captured page is invisible until its background drain embeds it. Priority + the resilience re-drain shorten that window; document-level does nothing for it. Do NOT claim the change "fixes no results" - it shortens the unsearchable window. (A future "indexing N..." popup hint would make this visible to users.)
- **`k` now means PAGES, not chunks.** `App.tsx` calls `recall` with `k: 5` -> five documents.

# Granite Embedding Model Swap + Gradual Re-Index Migration Implementation Plan (v3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **v3 (owner decisions that SIMPLIFY v2).** Two calls from the owner shrink the design:
> - **(D1) granite-ONLY — drop the e5 fallback.** v2 kept e5 bundled as a per-device fallback (~260MB bundle, per-model version branching). v3 ships ONLY granite (WebGPU primary, WASM fallback) for a lean ~124MB bundle. If granite cannot be created on a device (BOTH WebGPU and WASM fail), the side panel shows an explicit "this device can't run the on-device model — search is unavailable" state instead of silently piling up NULL-vector chunks. The persisted version is single (one shipped model => one id); the e5-era -> granite-era re-index still runs.
> - **(D2) bundle granite via Git LFS — no external host.** v2 fetched the granite artifact from a public host at build. v3 COMMITS the first-party granite files into the repo (recommended via Git LFS) and ships them directly; `fetch-model.mjs` is repurposed from a downloader into a verifier of the committed bytes.
>
> Kept from v2: the (C1) probe-our-artifact gate (now ALREADY PASSED in a node smoke run — kept as the owner's manual WebGPU gate), the (I1) gradual page-by-page re-index with a real "N of M" denominator, the cosine-floor audit, the `tokenizer.json` use_fast assert (I5), the corpus-size budget note, and the stale-header fix. See each task's `> v3` note for what changed.

**Goal:** Make the bundled embedding model `granite-embedding-107m-multilingual` (R1) the **only** model, so Korean<->English cross-lingual search works without breaking the majority EN->EN case. Ship it as the single on-device embedder (WebGPU primary, WASM fallback). On the model change, re-embed every stored chunk **gradually** (page by page) so search degrades smoothly instead of going blank.

**Architecture:** Granite is the same 384-dim space as the old e5 model, so the vector store schema and ranking are unchanged. The swap is: (1) bundle a SAFE first-party granite ONNX (we re-quantize IBM's official fp32 ONNX ourselves, never the community quant) and COMMIT it into the repo via Git LFS — e5 is deleted entirely; (2) the embedder loads ONLY granite (WebGPU first, single-thread WASM fallback) with NO model-level fallback — if granite cannot be created on either provider, the embedder surfaces an explicit "unavailable" state to the side panel; (3) persist a single embedding-model **version** in settings and, when it differs from the stored value (the e5-era profile has none, or a legacy id), re-embed the corpus **one page at a time**, overwriting each page's vectors in place so already-re-embedded pages stay searchable the whole time. The re-index reuses the existing `runDrainWithProgress()` broadcast plus a small additive `total` field so the side panel can show real progress.

**Tech Stack:** TypeScript, Preact, `@huggingface/transformers` (transformers.js, WebGPU primary / WASM fallback), SQLite-WASM over OPFS in a worker, Vitest (unit), Playwright (e2e), Vite + CRXJS (build), Git LFS (committed weights), Python `optimum`/`onnxruntime` (offline re-quantize recipe).

---

## Background the engineer needs

Read these before starting. They are the load-bearing facts.

- **Why granite, why R1, why a re-index:** `docs/embedding-ab-results.md`. R1 is the only candidate with no broken language combo (keeps EN->KO alive), best overall MRR, 384-dim (no schema change). R2 and EmbeddingGemma collapse EN->KO to P@1 0.00 and are rejected. **CAUTION (carried from v2):** the A/B numbers and the spike probe (`device=webgpu dims=384 cos(bacteria, 박테리아)=0.698`) were measured on the **COMMUNITY** quant (`gety-ai .../model_qint8_arm64.onnx`), NOT on the artifact we will ship. The A/B's eval also ran on **onnxruntime-node** (CPU int8), a different runtime from **onnxruntime-web** (WASM/WebGPU). Those numbers are evidence the MODEL is right, not proof OUR file loads or scores the same. Task 7 (probe — now ALREADY PASSED in a node smoke run, kept as the manual WebGPU gate) and Task 12 (eval) are the FIRST measurements of our own artifact.
- **The embedder:** `src/offscreen/webgpu-embedder.ts`. It runs the model in the offscreen document, WebGPU first and WASM single-thread as fallback, with a two-lane (query=high priority / passage=low priority) single-flight scheduler. The old e5 needed `query: ` / `passage: ` prefixes; **granite uses none** (raw `input_ids` + `attention_mask`). v3 keeps ONLY the existing device fallback axis (webgpu -> wasm); there is NO model fallback axis (no granite -> e5). When BOTH providers fail, `ensureLoaded()` rejects and the offscreen turns that into a user-visible "unavailable" notice.
- **How weights are bundled (CHANGED in v3):** granite is now COMMITTED into the repo under `public/models/granite/` (recommended via Git LFS — see `.gitattributes`). `scripts/fetch-model.mjs` no longer downloads anything; it is repurposed to VERIFY the committed files' SHA-256 (it catches a clone that forgot `git lfs pull`, and any tampered/corrupt weight). Vite copies `public/` verbatim into the build `outDir` (`dist-ext` for `npm run build`), so `public/models/granite/...` becomes `dist-ext/models/granite/...`. The old e5 dir `public/models/Xenova/...` is removed.
- **The drain (re-index engine):** `src/core/indexing-service.ts`. `drain()` loops `store.pendingChunks(batch)` (chunks whose `vector IS NULL`) and embeds them. **Setting a chunk's vector back to NULL re-queues it for the drain.** That is the migration mechanism — but in v3 we null ONE PAGE at a time, not the whole corpus, so only that page is briefly unsearchable.
- **Storage:** `src/offscreen/sqlite-worker.ts` (`chunks` table with a `vector BLOB NULL` column; `settings` key/value table), surfaced through `src/offscreen/worker-vector-store.ts` and `src/offscreen/worker-settings-store.ts` over `src/offscreen/sqlite-worker-client.ts`. The in-memory twin used in tests and the eval is `src/adapters/memory-vector-store.ts`; the two engines are kept byte-for-byte equivalent (ADR 0020).
- **Ranking is relative, not cosine-thresholded:** `src/core/rrf.ts` (rank-based fusion), `src/core/ranking.ts` (`topPagesBySnippet` ranks by relative score; `chooseSnippetChunk` compares to `maxCos - epsilon`, a RELATIVE delta; `SNIPPET_TAU` is a prose-text threshold, not cosine), `src/core/cosine.ts`, `src/core/recall-service.ts` (orchestrates query-embed -> store.search; holds no cosine constant). Granite's unrelated-pair cosine floor is high (~0.56-0.65), so any ABSOLUTE cosine cutoff would break — Task 11 audits that none exists.
- **The throwaway probe:** `src/offscreen/offscreen.ts` has a `granite-probe` RPC op, a `runGraniteProbe()` function, and a `__graniteProbe` global. In v3 Task 7 RE-POINTS this probe at OUR first-party file under the production invocation (it currently loads the community file) and uses it as the swap GATE; Task 9 deletes it afterward.
- **Parallel work — coordinate, mostly untouched:** another task owns `src/ui/*` and `manifest.config.ts`. v3 deliberately reuses the EXISTING `indexing-progress` / `indexing-complete` broadcast (offscreen -> SW -> panel). It needs ONE small ADDITIVE edit to `src/background/index.ts` (Task 10): carry a `total` field through the relay and relay a new `embedder-degraded` event (whose `state` is `wasm` for "running slow" or `unavailable` for "no search on this hardware"). The only `manifest.config.ts` touch is a one-line COMMENT update (Task 6) about how the model is bundled — coordinate with the SW/manifest owner. Consuming the new fields in the IndexingIndicator is a one-line follow-up the parallel task can pick up.

---

## File Map

**Create:**
- `src/core/embed-version.ts` — pure: the SINGLE embedding-model version id (`EMBED_MODEL_VERSION` = granite's) and the `needsReindex()` decision. (v3: no per-model branching — one shipped model, one id.)
- `src/core/embed-migration.ts` — pure orchestration: `migrateEmbeddingModel(store, versions, current, reembedPending, onProgress)` — page-by-page null + re-embed + record version, emitting `{done,total}` progress.
- `tests/core/embed-version.test.ts` — unit tests for `needsReindex` and the version constant.
- `tests/core/embed-migration.test.ts` — integration tests over the REAL `MemoryVectorStore` + real `IndexingService` + a fake embedder + a fake version store; asserts gradual (never all-dark) re-embed and progress.
- `scripts/quantize-granite.py` — the SAFE re-quantize recipe (IBM official fp32 ONNX -> first-party `model_quantized.onnx`), pinned + hash-printing + `tokenizer.json` assertion. Outputs are COMMITTED via Git LFS (v3), not published to a host.
- `.gitattributes` — Git LFS tracking for `public/models/granite/**` so the committed weights don't bloat every clone. (v3, recommended path.)
- `tests/e2e/granite-reindex.spec.ts` — e2e: granite loads + retrieves on the real extension path; a relaunch on a matching version does NOT re-index; a re-index keeps already-done pages searchable.

**Modify:**
- `src/offscreen/webgpu-embedder.ts` — granite ONLY (no prefix); WebGPU primary / WASM fallback; on WASM fallback fire a degraded sink; on BOTH-provider failure let `ensureLoaded()` reject (offscreen surfaces "unavailable"); `env.useBrowserCache=false`; stale file header (M2). (v3: e5 path removed entirely.)
- `tests/core/webgpu-embedder.test.ts` — granite-no-prefix assertions; WASM-degraded sink assertion; both-providers-fail rejects assertion. (v3: e5-fallback test removed.)
- `src/core/ports.ts` — add `clearVectorsForPage(pageId)` to `VectorSearchPort`; add `getEmbedVersion()`/`setEmbedVersion()` to `SettingsPort`.
- `src/adapters/memory-vector-store.ts` — implement `clearVectorsForPage()`.
- `tests/core/memory-vector-store.test.ts` — test `clearVectorsForPage()`.
- `src/offscreen/sqlite-worker.ts` — `clearVectorsForPage`, `getEmbedVersion`, `setEmbedVersion` ops + handlers.
- `src/offscreen/worker-vector-store.ts` — `clearVectorsForPage()` passthrough.
- `src/offscreen/worker-settings-store.ts` — `getEmbedVersion()`/`setEmbedVersion()` passthrough.
- `src/offscreen/offscreen.ts` — Task 7: re-point the probe at OUR file (gate); Task 9: remove the probe + run `migrateEmbeddingModel(...)` after the model loads, then drain; on granite-unavailable emit the `embedder-degraded` (`state:'unavailable'`) event and skip the drain; emit re-index `total` and the `wasm`-degraded event.
- `src/background/index.ts` — minimal additive relay: pass a `total` field through `indexing-progress`; relay a new `embedder-degraded` event carrying `state` (`wasm` | `unavailable`).
- `scripts/fetch-model.mjs` — REPURPOSED from downloader to VERIFIER: hash-check the COMMITTED granite files (no network); remove the e5 fetch. (v3.)
- `manifest.config.ts` — one-line COMMENT update: the model is COMMITTED via Git LFS and verified locally, not fetched from a host. (Coordinate with the manifest owner.)
- `.gitignore` — stop ignoring `public/models/` (granite is committed now); ignore only stale `public/models/Xenova/` so a leftover e5 download can't be re-committed.
- `eval/lib/embed-node.mjs` — default the eval to granite (bundled id + `none` prefix).
- `tests/core/embedding-model.node.test.ts` — retarget the cross-lingual guard to the bundled granite (no prefix). (v3: e5 sanity check removed — e5 is gone.)

---

### Task 1: Pure version identifier (single) + re-index decision

> **v3 (simplified from v2):** there is exactly ONE shipped model, so there is exactly ONE version id. v2 kept a per-model id (`granite` vs `e5`) and a `versionForModel()` picker because e5 was a live fallback; with e5 dropped, that branching is gone. A device that last indexed with the old e5 model has either NO stored version (fresh) or a legacy value; either way it differs from granite's id, so the migration re-embeds.

**Files:**
- Create: `src/core/embed-version.ts`
- Test: `tests/core/embed-version.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/embed-version.test.ts
import { needsReindex, EMBED_MODEL_VERSION } from '../../src/core/embed-version'

// Scenario: a profile that last embedded with a different (or no) model must trigger a
// re-index; a profile already on granite must not. The "same version" check is what keeps a
// granite device from re-indexing on every launch.
// Coverage: integration (the real pure decision function).
test('needsReindex is true for a null or legacy stored version, false when equal', () => {
  expect(needsReindex(null, EMBED_MODEL_VERSION)).toBe(true)
  expect(needsReindex('e5-small-q8-v1', EMBED_MODEL_VERSION)).toBe(true)
  expect(needsReindex(EMBED_MODEL_VERSION, EMBED_MODEL_VERSION)).toBe(false)
})

// Scenario: the version string is the single source of truth shared by the migration and the
// eval default. A typo silently disables the migration.
// Coverage: integration (locks the literal value).
test('version id is the granite r1 q8 identifier', () => {
  expect(EMBED_MODEL_VERSION).toBe('granite-107m-r1-q8-v1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/embed-version.test.ts`
Expected: FAIL — cannot resolve `../../src/core/embed-version`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/embed-version.ts
// The bundled embedding model's identity, persisted per-profile so a model swap can trigger a
// one-time corpus re-index. Bump the trailing -vN whenever the SHIPPED granite weights change
// in a way that makes old vectors incomparable (new dtype, new dims): the offscreen migration
// compares this id to the stored value and re-embeds the corpus on a mismatch.
//
// granite-only: there is exactly ONE shipped model, so exactly ONE version id. A device that
// last indexed with the old e5 model has no stored version (fresh) or a legacy value; either
// differs from this id, so the migration re-embeds with granite.
export const EMBED_MODEL_VERSION = 'granite-107m-r1-q8-v1'

// True when the stored version is missing or differs from the current one, i.e. a re-index is
// required. Pure: the offscreen wires the real settings + store around this decision.
export function needsReindex(stored: string | null, current: string): boolean {
  return stored !== current
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/embed-version.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/embed-version.ts tests/core/embed-version.test.ts
git commit -m "feat(core): single embedding-version id (EMBED_MODEL_VERSION) + needsReindex"
```

---

### Task 2: `clearVectorsForPage` on the port + in-memory store

> **(carried from v2)** Nulling the WHOLE corpus at once made search blank until the whole drain finished (I1). The migration nulls ONE page at a time, so only that page is briefly unsearchable while every other page keeps serving results.

**Files:**
- Modify: `src/core/ports.ts`
- Modify: `src/adapters/memory-vector-store.ts`
- Test: `tests/core/memory-vector-store.test.ts`

- [ ] **Step 1: Add the method to the port (compile-time RED)**

In `src/core/ports.ts`, inside `interface VectorSearchPort`, add after the `setVector` line:

```typescript
  // Reset ONE page's chunk vectors to pending (NULL). Used by the model-swap migration to
  // re-embed the corpus a page at a time: after this, pendingChunks() returns this page's
  // chunks and the drain re-embeds them with the loaded model. Every OTHER page keeps its
  // vectors and stays searchable. Page and chunk text are untouched.
  clearVectorsForPage(pageId: string): Promise<void>
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/core/memory-vector-store.test.ts  (append)
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { CapturedPage, Chunk } from '../../src/core/model'

// Scenario: the re-index re-embeds one page at a time. Clearing page p1 must re-queue ONLY
// p1's chunks (removing them from search until re-embedded) while page p2 stays searchable.
// This per-page scope is what keeps the corpus from going blank during a migration.
// Coverage: integration (real MemoryVectorStore - the VectorSearchPort contract).
test('clearVectorsForPage re-queues only that page and leaves others searchable', async () => {
  const store = new MemoryVectorStore()
  const p1: CapturedPage = { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 }
  const p2: CapturedPage = { id: 'p2', url: 'http://y', title: 'Y', capturedAt: 2 }
  const a: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'cortisol and sleep' }
  const b: Chunk = { id: 'p2#0', pageId: 'p2', index: 0, text: 'tax accounting basics' }
  await store.upsertPage(p1)
  await store.upsertPage(p2)
  await store.putChunks('p1', [a])
  await store.putChunks('p2', [b])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  await store.setVector('p2#0', new Float32Array([0, 1]))

  await store.clearVectorsForPage('p1')

  const pending = await store.pendingChunks(100)
  expect(pending.map((c) => c.id)).toEqual(['p1#0']) // only p1 re-queued
  // p2 is still embedded and searchable.
  expect((await store.search(new Float32Array([0, 1]), '', 10)).length).toBeGreaterThan(0)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/core/memory-vector-store.test.ts -t clearVectorsForPage`
Expected: FAIL — `store.clearVectorsForPage is not a function` (and a type error on the port).

- [ ] **Step 4: Implement in the in-memory store**

In `src/adapters/memory-vector-store.ts`, add after `setVector`:

```typescript
  async clearVectorsForPage(pageId: string): Promise<void> {
    for (const entry of this.chunks.values()) {
      if (entry.chunk.pageId === pageId) entry.vector = null
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/memory-vector-store.test.ts -t clearVectorsForPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/ports.ts src/adapters/memory-vector-store.ts tests/core/memory-vector-store.test.ts
git commit -m "feat(core): clearVectorsForPage on VectorSearchPort + memory store (per-page re-index)"
```

---

### Task 3: Pure gradual-migration orchestration

> **(carried from v2)** the migration drives the re-index PAGE BY PAGE (I1). For each page it nulls that page's vectors then re-embeds the now-pending chunks via the injected drain, so already-done pages stay searchable and a real `{done,total}` denominator falls out. It is interrupt-safe: the version is recorded only after every page is done, so a crash mid-run just re-runs the (idempotent) loop next launch.
>
> **v3:** `current` is simply `EMBED_MODEL_VERSION` (granite's) — there is no `versionForModel(loadedModel)` indirection anymore.

**Files:**
- Create: `src/core/embed-migration.ts`
- Test: `tests/core/embed-migration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/embed-migration.test.ts
import { migrateEmbeddingModel, type EmbedVersionStore } from '../../src/core/embed-migration'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import { IndexingService } from '../../src/core/indexing-service'
import type { EmbeddingPort } from '../../src/core/ports'
import type { CapturedPage, Chunk } from '../../src/core/model'

function fakeVersions(initial: string | null): EmbedVersionStore & { value: string | null } {
  const state = { value: initial }
  return {
    get value() {
      return state.value
    },
    async getEmbedVersion() {
      return state.value
    },
    async setEmbedVersion(v: string) {
      state.value = v
    },
  } as EmbedVersionStore & { value: string | null }
}

// A fake embedder that stamps a recognizable vector so we can tell a re-embed happened, and
// that records the peak number of pending chunks it ever saw in a single drain. The peak is
// the gradual guarantee: with two single-chunk pages a page-by-page migration must never see
// more than ONE pending chunk at a time (all-at-once would see two).
function spyEmbedder(): { port: EmbeddingPort; peakPending: () => number; setPeek: (n: number) => void } {
  let peek = 0
  let peak = 0
  const port: EmbeddingPort = {
    async embed(texts) {
      peak = Math.max(peak, peek)
      return texts.map(() => new Float32Array([9, 9]))
    },
  }
  return { port, peakPending: () => peak, setPeek: (n) => { peek = n } }
}

async function seededTwoPageStore(): Promise<MemoryVectorStore> {
  const store = new MemoryVectorStore()
  const pages: CapturedPage[] = [
    { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 },
    { id: 'p2', url: 'http://y', title: 'Y', capturedAt: 2 },
  ]
  for (const p of pages) await store.upsertPage(p)
  const c1: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'alpha' }
  const c2: Chunk = { id: 'p2#0', pageId: 'p2', index: 0, text: 'beta' }
  await store.putChunks('p1', [c1])
  await store.putChunks('p2', [c2])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  await store.setVector('p2#0', new Float32Array([0, 1]))
  return store
}

// Scenario: the model changed since this profile was last indexed (e5-era -> granite). Every
// page must be re-embedded with granite and the new version recorded - but page by page,
// never blanking the whole corpus at once.
// Coverage: integration (real MemoryVectorStore + real IndexingService + fake embedder).
test('stale version re-embeds every page gradually and records the new version', async () => {
  const store = await seededTwoPageStore()
  const versions = fakeVersions('e5-small-q8-v1')
  const spy = spyEmbedder()
  const indexing = new IndexingService(store, spy.port)
  const progress: { done: number; total: number }[] = []

  const reindexed = await migrateEmbeddingModel(
    store,
    versions,
    'granite-107m-r1-q8-v1',
    async () => {
      // Before draining, record how many chunks are pending so the test can assert that the
      // migration never nulls more than one page's worth at a time.
      spy.setPeek((await store.pendingChunks(100)).length)
      await indexing.drain()
    },
    (p) => progress.push(p),
  )

  expect(reindexed).toBe(true)
  expect((await store.pendingChunks(100)).length).toBe(0) // all re-embedded
  expect(await versions.getEmbedVersion()).toBe('granite-107m-r1-q8-v1')
  expect(progress).toEqual([{ done: 1, total: 2 }, { done: 2, total: 2 }])
  expect(spy.peakPending()).toBe(1) // never more than one page pending => gradual, not dark
})

// Scenario: a profile already on granite reopens the extension. The migration must be a no-op:
// it must NOT clear durable vectors and force a needless re-embed every launch.
// Coverage: integration (real MemoryVectorStore + fake version store).
test('matching version is a no-op (vectors preserved, no re-embed)', async () => {
  const store = await seededTwoPageStore()
  const versions = fakeVersions('granite-107m-r1-q8-v1')
  let drained = 0

  const reindexed = await migrateEmbeddingModel(
    store,
    versions,
    'granite-107m-r1-q8-v1',
    async () => {
      drained++
    },
  )

  expect(reindexed).toBe(false)
  expect(drained).toBe(0)
  expect((await store.pendingChunks(100)).length).toBe(0) // still embedded
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/embed-migration.test.ts`
Expected: FAIL — cannot resolve `../../src/core/embed-migration`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/embed-migration.ts
import type { VectorSearchPort } from './ports'
import { needsReindex } from './embed-version'

// The persisted embedding-model version, read/written around the corpus re-index.
export interface EmbedVersionStore {
  getEmbedVersion(): Promise<string | null>
  setEmbedVersion(version: string): Promise<void>
}

// If the stored embedding-model version differs from `current`, re-embed the whole corpus
// with granite - but ONE PAGE AT A TIME so search stays mostly alive. For each page we null
// its vectors (only that page leaves search) and immediately re-embed the now-pending chunks
// via `reembedPending` (the offscreen passes the real drain), so the page is searchable again
// before we touch the next one. `onProgress` reports {done,total} pages for the UI bar.
//
// Order matters for interrupt-safety: the new version is recorded only AFTER every page is
// done. A crash mid-run leaves some pages pending and the version unchanged, so the next
// launch simply re-runs the loop (re-nulling an already-migrated page and re-embedding it is
// wasted work but never wrong). Returns true when a re-index was triggered.
export async function migrateEmbeddingModel(
  store: Pick<VectorSearchPort, 'clearVectorsForPage' | 'recentPages'>,
  versions: EmbedVersionStore,
  current: string,
  reembedPending: () => Promise<void>,
  onProgress?: (p: { done: number; total: number }) => void,
): Promise<boolean> {
  const stored = await versions.getEmbedVersion()
  if (!needsReindex(stored, current)) return false

  // Snapshot every page id. recentPages with a huge limit returns the whole corpus; order is
  // irrelevant here (every page gets re-embedded).
  const pages = await store.recentPages(Number.MAX_SAFE_INTEGER)
  const total = pages.length
  for (let i = 0; i < pages.length; i++) {
    await store.clearVectorsForPage(pages[i].id) // only this page leaves search
    await reembedPending() // drain re-embeds it (+ any newly captured chunks) -> searchable
    onProgress?.({ done: i + 1, total })
  }

  await versions.setEmbedVersion(current)
  return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/embed-migration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/embed-migration.ts tests/core/embed-migration.test.ts
git commit -m "feat(core): gradual page-by-page migrateEmbeddingModel with {done,total} progress"
```

---

### Task 4: Persist the version + per-page clear in the sqlite worker

**Files:**
- Modify: `src/core/ports.ts`
- Modify: `src/offscreen/sqlite-worker.ts`
- Modify: `src/offscreen/worker-vector-store.ts`
- Modify: `src/offscreen/worker-settings-store.ts`

> This task wires the OPFS-backed implementations of the contracts added in Tasks 2-3. The worker runs only inside the extension (real OPFS), so it has no Vitest unit; it is exercised by the Task 14 e2e. The pure contracts it satisfies are already proven by Tasks 2-3.

- [ ] **Step 1: Extend the settings port**

In `src/core/ports.ts`, inside `interface SettingsPort`, add after `removeDenyHost`:

```typescript
  // The embedding-model version last used to embed this profile (null on a fresh DB).
  getEmbedVersion(): Promise<string | null>
  setEmbedVersion(version: string): Promise<void>
```

- [ ] **Step 2: Add the worker ops**

In `src/offscreen/sqlite-worker.ts`, add these three handler functions next to the other `op*` functions (after `opDeletePagesByHost`):

```typescript
function opClearVectorsForPage(db: any, pageId: string): void {
  // Re-queue ONLY this page's chunks for the drain by nulling their vectors. Other pages
  // keep their vectors and stay searchable. Page/chunk text untouched.
  db.exec({ sql: `UPDATE chunks SET vector = NULL WHERE pageId = ?`, bind: [pageId] })
}

function opGetEmbedVersion(db: any): string | null {
  let version: string | null = null
  db.exec({
    sql: `SELECT value FROM settings WHERE key='embedModelVersion'`,
    rowMode: 'array',
    callback: (r: any) => { version = r[0] },
  })
  return version
}

function opSetEmbedVersion(db: any, version: string): void {
  db.exec({
    sql: `INSERT OR REPLACE INTO settings (key, value) VALUES ('embedModelVersion', ?)`,
    bind: [version],
  })
}
```

- [ ] **Step 3: Register them in the handler map**

In the `handlers` map in `src/offscreen/sqlite-worker.ts`, add:

```typescript
  clearVectorsForPage: (db, args) => { opClearVectorsForPage(db, args as string) },
  getEmbedVersion: (db) => opGetEmbedVersion(db),
  setEmbedVersion: (db, args) => { opSetEmbedVersion(db, args as string) },
```

- [ ] **Step 4: Add the vector-store passthrough**

In `src/offscreen/worker-vector-store.ts`, add after the `setVector` line:

```typescript
  clearVectorsForPage = (pageId: string) => this.c.request<void>('clearVectorsForPage', pageId)
```

- [ ] **Step 5: Add the settings-store passthrough**

In `src/offscreen/worker-settings-store.ts`, add after the `removeDenyHost` line:

```typescript
  getEmbedVersion = () => this.c.request<string | null>('getEmbedVersion')
  setEmbedVersion = (version: string) => this.c.request<void>('setEmbedVersion', version)
```

- [ ] **Step 6: Typecheck + full unit suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — no type errors; `WorkerVectorStore` satisfies `VectorSearchPort` and `WorkerSettingsStore` satisfies `SettingsPort` with the new members.

- [ ] **Step 7: Commit**

```bash
git add src/core/ports.ts src/offscreen/sqlite-worker.ts src/offscreen/worker-vector-store.ts src/offscreen/worker-settings-store.ts
git commit -m "feat(offscreen): persist embed-model version + clearVectorsForPage worker op"
```

---

### Task 5: Safe first-party re-quantize recipe

> **Why this exists.** The spike loaded `gety-ai/...`'s community int8 binary. We must NOT bundle an unaudited third-party quant in a privacy extension. Instead we re-quantize IBM's OFFICIAL fp32 ONNX ourselves into a standard-named `onnx/model_quantized.onnx` that transformers.js loads with the normal `dtype:'q8'`. (The A/B noted `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` ships a clean standard quant, but that is R2 — rejected for collapsing EN->KO — so we cannot just grab a clean R2 build.) This script is run once by a maintainer / in CI; **in v3 its outputs are COMMITTED into the repo via Git LFS (Task 6), not published to an external host.** It is not part of `npm run build`.
>
> **(I5)** granite R1 is XLM-RoBERTa / SentencePiece. `save_pretrained` writes a transformers.js-loadable `tokenizer.json` ONLY for a FAST tokenizer, and transformers.js loads `tokenizer.json` exclusively. So the recipe FORCES `use_fast=True` and ASSERTS `tokenizer.json` exists after save — if it does not, the script fails loudly instead of producing an artifact that cannot tokenize in the browser.
>
> **Already produced (de-risk).** This recipe has been run; the committed artifact's SHA-256 are known and are pinned in Task 6's verifier:
> - `onnx/model_quantized.onnx` `08da7a657ba6069b389b9cc0742a7d623542f48d322b84f489ba3acaf4aab76d` (~107MB)
> - `tokenizer.json` `14917dd757b81bc44d4af6b028367351702656670c1954e055dabdfcf21593cf` (~17MB)
> - `config.json` `624bd250...` (full digest in Task 6)
> - `tokenizer_config.json` `a572845c...` (full digest in Task 6)

**Files:**
- Create: `scripts/quantize-granite.py`

- [ ] **Step 1: Write the recipe script**

```python
#!/usr/bin/env python3
# scripts/quantize-granite.py
# SAFE first-party artifact builder for the bundled granite embedding model.
#
# Exports IBM's OFFICIAL fp32 model to ONNX, then dynamic-int8-quantizes it into a
# transformers.js-standard onnx/model_quantized.onnx. Run by a maintainer or CI; the outputs
# (config.json, tokenizer_config.json, tokenizer.json, onnx/model_quantized.onnx) are then
# COMMITTED into the repo under public/models/granite/ via Git LFS (see Task 6) - NOT published
# to an external host.
#
#   pip install "optimum[onnxruntime]==1.23.3" "transformers==4.44.2"
#   python scripts/quantize-granite.py
#
# Pinned source: IBM official repo at a fixed revision (NOT a community quant).
import hashlib
import os
from optimum.onnxruntime import ORTModelForFeatureExtraction, ORTQuantizer
from optimum.onnxruntime.configuration import AutoQuantizationConfig
from transformers import AutoTokenizer

MODEL_ID = "ibm-granite/granite-embedding-107m-multilingual"
REVISION = "main"  # PIN to a commit SHA before committing the artifact (replace "main").
OUT = "dist-model/granite"
ONNX_DIR = os.path.join(OUT, "onnx")
os.makedirs(ONNX_DIR, exist_ok=True)

# 1. Export the official fp32 model to ONNX (this downloads IBM's weights, not a quant).
model = ORTModelForFeatureExtraction.from_pretrained(MODEL_ID, revision=REVISION, export=True)
model.save_pretrained(OUT)

# 1b. (I5) Save a FAST tokenizer so save_pretrained emits tokenizer.json (transformers.js
#     loads ONLY tokenizer.json; a slow/SentencePiece-only save would have no tokenizer.json
#     and the model would fail to tokenize in the browser).
AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION, use_fast=True).save_pretrained(OUT)
tok_json = os.path.join(OUT, "tokenizer.json")
assert os.path.exists(tok_json), (
    "tokenizer.json was NOT written - the fast tokenizer is required for transformers.js. "
    "Check use_fast=True and that a fast tokenizer is available for this model."
)

# 2. Dynamic int8 quantization (avx2 dynamic = CPU-portable int8, the q8 transformers.js loads).
quantizer = ORTQuantizer.from_pretrained(OUT, file_name="model.onnx")
qconfig = AutoQuantizationConfig.avx2(is_static=False, per_channel=False)
quantizer.quantize(save_dir=OUT, quantization_config=qconfig)

# 3. Normalize the quantized file name to the transformers.js convention.
produced = os.path.join(OUT, "model_quantized.onnx")
target = os.path.join(ONNX_DIR, "model_quantized.onnx")
if os.path.exists(produced):
    os.replace(produced, target)
assert os.path.exists(target), "model_quantized.onnx was not produced - check the quantize step."

# 4. Print SHA-256 of every file Task 6 commits, to paste into the verifier's HASHES.
for rel in ["config.json", "tokenizer_config.json", "tokenizer.json", "onnx/model_quantized.onnx"]:
    path = os.path.join(OUT, rel)
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    size_mb = os.path.getsize(path) / 1e6
    print(f"{rel:34s} {digest}  ({size_mb:.1f} MB)")
```

- [ ] **Step 2: Document the reproduce + commit flow (no code; referenced by Task 6)**

The reproduce flow is: (1) run the recipe with `REVISION` pinned to the exact IBM commit SHA; (2) copy the four outputs from `dist-model/granite/` into `public/models/granite/` (preserving the `onnx/` subdir); (3) commit them via Git LFS (Task 6 adds the `.gitattributes` rule first); (4) verify the printed SHA-256 match the values pinned in Task 6's verifier (`onnx/model_quantized.onnx` `08da7a65...`, `tokenizer.json` `14917dd7...`, `config.json` `624bd250...`, `tokenizer_config.json` `a572845c...`). This makes the build reproducible: anyone can re-run the pinned recipe and get byte-identical files.

- [ ] **Step 3: Commit**

```bash
git add scripts/quantize-granite.py
git commit -m "build: first-party granite re-quantize recipe (IBM official fp32 -> int8, asserts tokenizer.json)"
```

---

### Task 6: Commit the granite artifact via Git LFS + repurpose fetch-model + .gitignore + manifest comment

> **v3 (D2) — replaces v2's "fetch from a public host".** The owner wants the artifact bundled directly, not fetched from an external host. So granite is COMMITTED into the repo and shipped as-is. Recommended path: **Git LFS** — track the granite binaries in `.gitattributes` so day-to-day clones stay lean and only `git lfs pull` materializes the ~124MB. The build/CI then needs `git lfs` installed plus a `git lfs pull` step (a real new dependency — call it out in CI docs). Plain-commit (no LFS tooling, but ~124MB lives in git history forever and bloats every clone) is offered as the simpler-but-heavier alternative; **recommend LFS, let the owner pick.**
>
> Because nothing is fetched anymore, `scripts/fetch-model.mjs` is repurposed from a downloader into a VERIFIER: it hash-checks the committed files (no network). That still guards the two ways the committed bytes can be wrong at build time: a clone that forgot `git lfs pull` (the file is a tiny LFS pointer stub -> hash mismatch) and a corrupt/tampered weight. The npm scripts `prebuild` and `eval:fetch-model` keep pointing at this file; renaming it to `verify-model.mjs` is cosmetic and optional.

**Files:**
- Create: `.gitattributes`
- Modify: `scripts/fetch-model.mjs`
- Modify: `.gitignore`
- Modify: `manifest.config.ts`

- [ ] **Step 1: Add the Git LFS tracking rule (recommended path)**

Create `.gitattributes` at the repo root:

```gitattributes
# The bundled granite embedding artifact is committed via Git LFS to keep clones lean: a plain
# clone fetches small pointer stubs, and `git lfs pull` materializes the ~124MB of weights.
# Build/CI MUST run `git lfs install` once and `git lfs pull` before building or running the
# eval, or the model files will be pointer stubs and scripts/fetch-model.mjs will fail the hash
# check with a "run git lfs pull" message.
public/models/granite/** filter=lfs diff=lfs merge=lfs -text
```

> **Owner choice — LFS vs plain commit.** If the owner prefers NOT to take on the `git lfs` tooling/CI dependency, skip this file and commit the weights as ordinary blobs in Step 4. Trade-off: no extra tooling, but the ~124MB lands in git history permanently and every clone (now and forever) pays it. **Recommendation: LFS.**

- [ ] **Step 2: Repurpose `scripts/fetch-model.mjs` into a committed-artifact verifier**

Replace the whole download script with a no-network hash verifier of the committed granite files. Paste the real SHA-256 from the recipe (the two big files are known; fill the two JSON digests from the recipe output, prefixes `624bd250` / `a572845c`):

```javascript
#!/usr/bin/env node
// fetch-model.mjs -> now a VERIFIER (no download). The granite embedding model is COMMITTED
// into the repo under public/models/granite/ via Git LFS (see .gitattributes), so nothing is
// fetched at build. This runs in `prebuild` and CI to guard two failure modes:
//   1. a clone that did not run `git lfs pull` -> the files are tiny LFS pointer stubs -> the
//      SHA-256 will not match -> we fail with a clear "run git lfs pull" message.
//   2. a corrupted/tampered weight file -> hash mismatch -> build fails.
// No network, no npm deps - Node built-ins only. (Renaming this file to verify-model.mjs is
// cosmetic; the prebuild/eval:fetch-model npm scripts point here.)

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = resolve(ROOT, 'public/models/granite')

// SHA-256 of each committed granite file (printed by scripts/quantize-granite.py).
const HASHES = {
  'config.json':               '624bd250...', // full digest from quantize-granite.py output
  'tokenizer_config.json':     'a572845c...', // full digest from quantize-granite.py output
  'tokenizer.json':            '14917dd757b81bc44d4af6b028367351702656670c1954e055dabdfcf21593cf',
  'onnx/model_quantized.onnx': '08da7a657ba6069b389b9cc0742a7d623542f48d322b84f489ba3acaf4aab76d',
}

function sha256OfFile(absPath) {
  return new Promise((res, rej) => {
    const hash = createHash('sha256')
    const stream = createReadStream(absPath)
    stream.on('error', rej)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => res(hash.digest('hex')))
  })
}

console.log('[verify-model] Verifying committed granite artifact...')
try {
  for (const [rel, expected] of Object.entries(HASHES)) {
    const abs = resolve(DIR, rel)
    if (!existsSync(abs)) {
      throw new Error(`missing ${rel} - clone with Git LFS: run \`git lfs install && git lfs pull\``)
    }
    const actual = await sha256OfFile(abs)
    if (actual !== expected) {
      throw new Error(
        `SHA-256 mismatch for ${rel}:\n  expected ${expected}\n  got      ${actual}\n` +
        `If ${rel} is a Git LFS pointer stub, run: git lfs install && git lfs pull`,
      )
    }
    console.log(`[verify-model] ok ${rel} (${(statSync(abs).size / 1e6).toFixed(1)} MB)`)
  }
  console.log('[verify-model] granite artifact present and verified. Build may proceed.')
} catch (err) {
  console.error('[verify-model] FAILED:', err.message)
  process.exit(1)
}
```

> Alternative: DELETE `scripts/fetch-model.mjs` and the `prebuild` / `eval:fetch-model` npm scripts entirely, relying on `git lfs pull` to make the files present. Rejected as the default because the verifier is cheap and catches the very common "cloned without LFS" footgun with a clear message instead of a confusing transformers.js load error at runtime.

- [ ] **Step 3: Update `.gitignore` so granite is committed and stale e5 stays out**

In `.gitignore`, replace the e5-era block:

```
# Bundled embedding model — fetched by scripts/fetch-model.mjs (run via prebuild).
# Not committed: 135MB binary, reproducible via pinned SHA.
public/models/
```

with:

```
# The granite embedding model is COMMITTED via Git LFS (see .gitattributes, public/models/granite/).
# The old e5 model is removed; ignore any stale local copy so it can't be re-committed.
public/models/Xenova/
```

- [ ] **Step 4: Commit the granite weights + remove e5**

Materialize the four granite files under `public/models/granite/` (from the recipe output, Task 5 Step 2) and delete the old e5 dir, then commit:

```bash
git lfs install                      # one-time; skip if taking the plain-commit alternative
git rm -r --cached public/models/Xenova/multilingual-e5-small 2>/dev/null || true
rm -rf public/models/Xenova
git add .gitattributes .gitignore public/models/granite
git commit -m "build: commit first-party granite artifact via Git LFS; remove e5; repurpose fetch-model as verifier"
```

- [ ] **Step 5: Update the `manifest.config.ts` model-source comment (coordinate with the manifest owner)**

In `manifest.config.ts`, the `content_security_policy` comment currently says the model is `Xenova/multilingual-e5-small ... fetched at build time by scripts/fetch-model.mjs, pinned to commit SHA ...`. Replace that sentence with: the embedding model (granite-107m-multilingual R1, int8 quantized) is COMMITTED under `public/models/granite/` via Git LFS and VERIFIED at build by `scripts/fetch-model.mjs` (no remote fetch). Keep the surrounding `connect-src 'self'` / "nothing leaves the device" framing — it is now even truer (nothing is fetched at build either).

- [ ] **Step 6: Run the verifier**

Run: `npm run eval:fetch-model`
Expected: `ok` lines for all four `public/models/granite/...` files ending with `granite artifact present and verified.` (If a file is missing or a pointer stub, it fails with the `git lfs pull` hint — fix the LFS pull, do NOT edit the hashes.)

- [ ] **Step 7: Commit the manifest comment**

```bash
git add manifest.config.ts
git commit -m "docs(manifest): model is committed via Git LFS + verified locally, not fetched"
```

---

### Task 7: GATE — probe OUR first-party artifact under the production invocation

> **(C1) — the critical gate, now ALREADY PASSED in a node smoke run (GO).** The spike only proved the COMMUNITY `model_qint8_arm64.onnx` loads via `{dtype:'fp32', model_file_name}`. Production loads OUR optimum-avx2 `model_quantized.onnx` via `dtype:'q8'` — a DIFFERENT op-encoding the onnxruntime-web WASM/WebGPU execution providers may or may not support. A node smoke run of our committed q8 artifact already returned dims=384 with a sane KO<->EN cosine (GO), so the model is proven loadable; this task is the owner's MANUAL WebGPU confirmation in the real browser runtime (node CPU int8 is still a different EP than onnxruntime-web). It MUST pass before Task 8 (embedder swap). If it fails, our artifact is unshippable as-is: revisit the quant config (Task 5) — do NOT proceed to the swap.

**Files:**
- Modify: `src/offscreen/offscreen.ts` (temporarily re-point the existing `granite-probe`; Task 9 deletes it)

- [ ] **Step 1: Re-point the throwaway probe at OUR file with the PRODUCTION invocation**

In `runGraniteProbe()` in `src/offscreen/offscreen.ts`, change the load options from the community-file form to the production form, and run BOTH a WebGPU pass and a FORCED-WASM pass so we prove both execution providers accept our q8 op-encoding:

Replace:

```typescript
  const loadOpts = { dtype: 'fp32' as const, model_file_name: 'model_qint8_arm64' }
```

with:

```typescript
  // PRODUCTION invocation: dtype:'q8' loads onnx/model_quantized.onnx - OUR first-party
  // re-quantized file (Task 5/6), the exact bytes the shipped embedder will load. No
  // model_file_name override (q8 already resolves model_quantized.onnx).
  const loadOpts = { dtype: 'q8' as const }
```

and change the probe to run the texts on WebGPU AND then a forced WASM reload, logging device/dims/cosines for each. (Keep the existing `texts`, the cosine helper, and the `[Recall:granite]` log line shape; just run it twice — once per device — using `numThreads=1` for the forced-WASM pass exactly as the existing fallback branch does.)

- [ ] **Step 2: Build + load the extension and trigger the probe on BOTH execution providers**

Run: `npm run build` then load `dist-ext/` unpacked in Chrome. Open the offscreen document's DevTools console and run `await __graniteProbe()`.

- [ ] **Step 3: Assert the gate criteria (read the `[Recall:granite]` console lines)**

Both the WebGPU pass and the forced-WASM pass MUST report:
- the pipeline was CREATED (no throw on `dtype:'q8'` against our `model_quantized.onnx`),
- `device` = `webgpu` on the first pass and `wasm` on the forced pass,
- `dims = 384`,
- a SANE cross-lingual signal: `cos(bacteria, 박테리아)` clearly positive and clearly above `cos(bacteria, QCD)` (the unrelated pair). Treat a collapsed or inverted cosine as a FAIL.

If EITHER pass fails to create the pipeline or returns garbage cosines, STOP. Our q8 artifact is not usable on onnxruntime-web; re-check the quant config in Task 5 (try a different `AutoQuantizationConfig` op set) or the committed file — do NOT swap the embedder. The whole swap is gated here.

- [ ] **Step 4: Record the gate result (commit message only; no permanent code change — the probe edit is removed in Task 9)**

```bash
git commit --allow-empty -m "chore: GATE - first-party granite q8 artifact probed OK on WebGPU + forced-WASM (dims=384, KO<->EN cosine sane)"
```

---

### Task 8: Swap the embedder to granite ONLY (no e5)

> **Gated on Task 7 passing.** **v3 (D1):** the embedder loads ONLY granite. WebGPU first, single-thread WASM fallback (the existing device axis). There is NO model fallback — the e5 path is deleted. Two states are surfaced to the side panel via a sink, not a buried `console.warn` (I2): (a) a WASM fallback (granite runs but slow) fires a degraded sink; (b) BOTH providers failing means granite cannot run here at all — `ensureLoaded()` rejects and the offscreen turns that into a user-visible "unavailable" notice (Task 9). v3 (M2): fix the stale file header.

**Files:**
- Modify: `src/offscreen/webgpu-embedder.ts`
- Test: `tests/core/webgpu-embedder.test.ts`

- [ ] **Step 1: Update the embedder tests (RED)**

In `tests/core/webgpu-embedder.test.ts`:

(a) Replace the `kind prefix` test (e5 prefixes) with a granite no-prefix test:

```typescript
// Scenario: granite takes raw input_ids+attention_mask and must NOT receive the old e5
// "query: "/"passage: " prefixes; leaking them poisons every embedding.
// Coverage: integration (fake records the exact strings the model receives).
test('granite: raw text (no prefix) reaches the model for both lanes', async () => {
  const fake = makeFake()
  const embedder = new WebGpuEmbedder(fake.factory)

  await embedder.embed(['foo'], 'query')
  await embedder.embed(['bar'], 'passage')

  const flat = fake.calls.flat()
  expect(flat).toContain('foo')
  expect(flat).toContain('bar')
  expect(flat).not.toContain('query: foo')
  expect(flat).not.toContain('passage: bar')
})
```

(b) In the `priority` test, drop the prefixes from the expected order:

```typescript
  expect(fake.calls.flat()).toEqual(['p1', 'q1', 'p2'])
```

(c) In the `batching` test, the warmup call is the literal `warmup`; all real batches are raw passages:

```typescript
  const batchSizes = fake.calls.filter((c) => c[0] !== 'warmup').map((c) => c.length)
```

(d) Replace the e5-fallback test with a WASM-degraded test and an unavailable test. The fake's `failTimes` counts factory invocations; granite tries webgpu (call 1) then wasm (call 2):

```typescript
// Scenario: WebGPU is unavailable so granite loads on WASM single-thread (slower). The
// embedder must record device='wasm' AND fire the degraded sink so the side panel can show a
// "running slow" notice instead of a buried console.warn.
// Coverage: integration (fake fails webgpu once; wasm succeeds; asserts device + sink).
test('wasm fallback records device=wasm and fires the degraded sink', async () => {
  const fake = makeFake({ failTimes: 1 }) // fail granite on webgpu; wasm (2nd call) succeeds
  const embedder = new WebGpuEmbedder(fake.factory)
  const seen: { device: string }[] = []
  embedder.setDegradedSink((info) => seen.push(info))

  await embedder.embed(['foo'], 'query')

  expect(embedder.device).toBe('wasm')
  expect(seen).toEqual([{ device: 'wasm' }])
})

// Scenario: granite cannot be created on EITHER WebGPU or WASM - this device can't run the
// on-device model at all. ensureLoaded()/embed() MUST reject (the offscreen turns that into a
// user-visible "search unavailable on this hardware" notice) rather than hang or fake success.
// Coverage: integration (fake fails both granite attempts; asserts the load rejects).
test('granite unavailable on both providers rejects (offscreen surfaces unavailable)', async () => {
  const fake = makeFake({ failTimes: 2 }) // fail granite on webgpu AND wasm
  const embedder = new WebGpuEmbedder(fake.factory)
  await expect(embedder.embed(['foo'], 'query')).rejects.toBeTruthy()
})
```

> Note: the `poisoned pipe` test (`failTimes:2` then a successful retry) asserted `device==='webgpu'`. With granite-only and no model fallback, `failTimes:2` means "granite failed on webgpu AND wasm" -> the first `ensureLoaded()` rejects and nulls `pipeP`; the NEXT call (3rd factory invocation) loads granite on webgpu. This is exactly v1's two-attempt semantics, so `failTimes:2` is correct again (v2's `failTimes:4` was only needed because of the extra e5 attempts, which no longer exist). The `inference failure` and `single-flight` tests are model-agnostic and unchanged.

- [ ] **Step 2: Run the embedder tests to verify they fail**

Run: `npx vitest run tests/core/webgpu-embedder.test.ts`
Expected: FAIL — prefixes still present; no degraded sink; both-fail does not reject as expected.

- [ ] **Step 3: Implement the embedder swap (granite only)**

In `src/offscreen/webgpu-embedder.ts`:

(a) Fix the stale header (M2). Replace the top comment's "runs the multilingual-e5-small model" framing with: runs the granite-107m-multilingual model (raw text, NO prefix) in the offscreen document; WebGPU-first / single-thread-WASM fallback; if BOTH fail, the load rejects so the offscreen can show an "unavailable" state; still returns `number[][]` for RPC.

(b) Point the model constant at granite (loaded by the bare dir name `granite` from `env.localModelPath` = `public/models/`):

```typescript
// granite-107m-multilingual, committed under public/models/granite/ and loaded by its bare
// dir name. dtype:'q8' requests onnx/model_quantized.onnx - our FIRST-PARTY re-quantized
// artifact (Task 5/6). Granite takes RAW text (no e5-style query:/passage: prefix). 384-dim.
const MODEL_ID = 'granite'
```

(c) Add an optional degraded-state sink (mirrors `progressSink`) so the offscreen can surface a WASM fallback to the side panel (I2):

```typescript
  private degradedSink?: (info: { device: 'wasm' }) => void
  // The offscreen wires this to an 'embedder-degraded' rpc-event with state:'wasm'. Called once
  // granite loaded on WASM (slower than the WebGPU ideal). The side panel turns it into a
  // "running slow" notice instead of a buried console.warn. (The harder "unavailable" state -
  // granite failed on BOTH providers - is surfaced by the offscreen from ensureLoaded's
  // rejection, not from here.)
  setDegradedSink(cb: (info: { device: 'wasm' }) => void): void {
    this.degradedSink = cb
  }
```

(d) In `createPipe()`, keep the existing WebGPU-then-WASM structure but: warm up with raw `'warmup'` (not `'query: warmup'`), and on the WASM-success branch fire the degraded sink. The WebGPU branch already throws-through to WASM; the WASM branch already throws on failure (no further fallback), so a both-provider failure naturally rejects `createPipe` -> `getPipe` nulls `pipeP` -> `ensureLoaded` rejects. Concretely, the WASM branch becomes:

```typescript
    ;(env.backends.onnx as any).wasm.numThreads = 1
    const pipe = (await this.pipelineFactory('feature-extraction', MODEL_ID, {
      device: 'wasm',
      dtype: 'q8', // model_quantized.onnx - the same bundled file used by the WebGPU path.
      progress_callback: onProgress,
    })) as FeatureExtractionPipeline
    await pipe(['warmup'], { pooling: 'mean', normalize: true }) // raw text, no prefix
    this._device = 'wasm'
    console.warn('[recall] DEGRADED embedder: granite on WASM single-thread (slow)')
    this.degradedSink?.({ device: 'wasm' })
    console.log('[recall] embedder ready on WASM (single-thread)')
    return pipe
```

and the WebGPU warmup line likewise becomes `await pipe(['warmup'], { pooling: 'mean', normalize: true })`.

(e) In `configureEnv()`, after `env.allowRemoteModels = false`, disable the browser cache:

```typescript
    // We bundle the model locally, so transformers.js's browser cache is pointless and, in a
    // chrome-extension context, warns "Cache 'put' ... unsupported". Turn it off.
    env.useBrowserCache = false
```

(f) In `runEmbed()`, remove the prefixing entirely — granite takes raw text. Replace:

```typescript
        const slice = texts.slice(i, i + BATCH)
        const prefixed = slice.map((t) => `${kind}: ${t}`)
```

with:

```typescript
        // granite takes raw text in both lanes (no e5-style prefix). `kind` still drives the
        // two-lane scheduler priority; it no longer alters the text.
        const slice = texts.slice(i, i + BATCH)
```

and use `slice` in the `pipe(...)` call + the perf log (drop the old `prefixed` references).

- [ ] **Step 4: Run the embedder tests to verify they pass**

Run: `npx vitest run tests/core/webgpu-embedder.test.ts`
Expected: PASS — granite raw text (no prefix); WASM fallback fires the sink + device='wasm'; both-providers-fail rejects; priority `['p1','q1','p2']`; batches `[8,8,4]`.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/webgpu-embedder.ts tests/core/webgpu-embedder.test.ts
git commit -m "feat(offscreen): granite-only embedder (no e5), no prefix, WASM-degraded sink, cache off"
```

---

### Task 9: Run the migration on offscreen init + surface unavailable + remove the probe

> **v3:** the migration runs AFTER granite loads (so we only re-index when the model is actually usable). The persisted version is the single `EMBED_MODEL_VERSION` constant — no `versionForModel(loadedModel)` indirection. If granite FAILS to load on both providers, the offscreen emits an `embedder-degraded` event with `state:'unavailable'` and does NOT spin the drain (every embed would just fail). The throwaway probe (re-pointed in Task 7) is deleted here.

**Files:**
- Modify: `src/offscreen/offscreen.ts`

- [ ] **Step 1: Import the migration pieces**

```typescript
import { migrateEmbeddingModel } from '../core/embed-migration'
import { EMBED_MODEL_VERSION } from '../core/embed-version'
```

- [ ] **Step 2: Wire the WASM-degraded sink to an rpc-event (I2)**

Near `embedder.setProgressSink(emitModelProgress)`, add:

```typescript
// Surface a WASM fallback (granite runs but slow) to the SW -> side panel as a "running slow"
// notice. Consuming this in the IndexingIndicator is a one-line UI follow-up (parallel task);
// the event is emitted here regardless.
embedder.setDegradedSink((info) => {
  chrome.runtime
    .sendMessage({ channel: 'rpc-event', kind: 'embedder-degraded', state: 'wasm', device: info.device })
    .catch(() => {})
})
```

- [ ] **Step 3: Replace the on-load drain with load -> migrate -> drain, plus an unavailable path**

Replace the on-load `runDrainWithProgress()` (under "On load: resume any pending chunks") with: load granite first; on success run the gradual migrate then the normal drain; on failure (both providers) surface "unavailable" and skip the drain:

```typescript
// On load: (1) load granite; (2) if this profile's stored version differs from granite's
// (e5-era profiles have none, or a legacy id), re-embed the corpus PAGE BY PAGE - so search
// degrades gradually (already-re-embedded pages keep serving) instead of going blank; (3) run
// the normal drain afterward to finish any chunks left pending (a fresh capture or an
// interrupted re-index). The migration + drain broadcast indexing-progress (now with a
// `total`), which the side panel renders as the "updating search index N of M" state.
embedder
  .ensureLoaded()
  .then(async () => {
    await migrateEmbeddingModel(
      store,
      settings,
      EMBED_MODEL_VERSION,
      () =>
        new Promise<void>((done) => {
          // Re-embed the currently-pending chunks (this page's) and resolve when the drain ends.
          indexing.drain((n) => bumpReindexProgress(n)).then(() => done())
        }),
      (p) => emitReindexTotal(p),
    )
    await runDrainWithProgress() // finish any freshly-captured chunks
  })
  .catch((e) => {
    // ensureLoaded rejects ONLY when granite failed on BOTH WebGPU and WASM: this device cannot
    // run the on-device model. Surface an explicit "search unavailable on this hardware" state
    // so the user isn't left with capture silently piling up NULL-vector chunks that never
    // become searchable. Do NOT spin the drain - every embed would just fail.
    console.error('[recall/offscreen] granite unavailable on this device:', e)
    chrome.runtime
      .sendMessage({ channel: 'rpc-event', kind: 'embedder-degraded', state: 'unavailable' })
      .catch(() => {})
  })
```

> Implementation note: keep this simple. `indexing.drain` is single-flight, so the migration's per-page drain calls are serialized naturally. `bumpReindexProgress`/`emitReindexTotal` are two tiny helpers next to `runDrainWithProgress` that send the existing `indexing-progress` rpc-event with an added `total` field (the page count from `onProgress`). The load-bearing requirement is that the event now carries a `total` so the panel can show "N of M" (Task 10 relays it). Capture (the offscreen's capture op) is unchanged and still stores chunks with NULL vectors even when the embedder is unavailable — that is intentional: the data is kept so it becomes searchable if the user later opens the profile on capable hardware.

- [ ] **Step 4: Remove the throwaway probe — RPC op**

Delete the entire `if (op === 'granite-probe')` block (the `[THROWAWAY:granite-probe]` comment through `return await runGraniteProbe()`).

- [ ] **Step 5: Remove the throwaway probe — function + global**

Delete the entire trailing `[THROWAWAY:granite-probe]` section: the `runGraniteProbe()` function (including the Task-7 q8 edits) and the `;(globalThis as any).__graniteProbe = runGraniteProbe` line.

- [ ] **Step 6: Verify the probe is gone**

Run: `rg -n "granite-probe|__graniteProbe|runGraniteProbe" src`
Expected: NO matches.

- [ ] **Step 7: Typecheck + unit suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/offscreen/offscreen.ts
git commit -m "feat(offscreen): load granite -> gradual re-index -> drain; surface unavailable; remove probe"
```

---

### Task 10: Relay the re-index `total` + degraded event through the SW

> **(I1b, I2):** `broadcastIndexingProgress` sends only a running count, and the WASM/unavailable signal was a console.warn no user sees. This is the ONE small additive edit to `src/background/index.ts` (coordinate with its owner). It carries a `total` through `indexing-progress` so the panel can show a real "N of M" bar, and relays a new `embedder-degraded` event whose `state` is `wasm` (running slow) or `unavailable` (no search on this hardware). No `src/ui/*` change here — consuming the fields in the IndexingIndicator is the parallel task's one-line follow-up.

**Files:**
- Modify: `src/background/index.ts`

- [ ] **Step 1: Carry `total` through `broadcastIndexingProgress`**

Change the helper to forward an optional total:

```typescript
function broadcastIndexingProgress(pending: number, embedded: number, total?: number): void {
  chrome.runtime.sendMessage({ type: 'indexing-progress', pending, embedded, total }).catch(() => {})
}
```

- [ ] **Step 2: Pass the total from the rpc-event relay**

In the `kind === 'indexing-progress'` branch, forward the new field:

```typescript
  } else if (msg?.kind === 'indexing-progress') {
    broadcastIndexingProgress(1, (msg.embedded as number) ?? 0, msg.total as number | undefined)
```

- [ ] **Step 3: Relay the degraded event**

Add a branch in the rpc-event listener (alongside `indexing-error`):

```typescript
  } else if (msg?.kind === 'embedder-degraded') {
    // The embedder loaded on WASM (state:'wasm', running slow) OR could not load at all
    // (state:'unavailable', no on-device search on this hardware). Relay to the panel so it
    // can show the matching notice. UI consume is a follow-up; this just makes the signal
    // reachable instead of a buried offscreen warn.
    chrome.runtime
      .sendMessage({ type: 'embedder-degraded', state: msg.state })
      .catch(() => {})
  }
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. (The panel ignores the unknown `total`/`embedder-degraded` fields until the follow-up consumes them — additive and backward-compatible.)

- [ ] **Step 5: Commit**

```bash
git add src/background/index.ts
git commit -m "feat(bg): relay re-index total + embedder-degraded event (wasm | unavailable, additive)"
```

---

### Task 11: Cosine-floor audit (verification)

> Granite's unrelated-pair cosine sits high (~0.56-0.65). Ranking is preserved because it is RELATIVE (RRF rank-based, top-by-score, relative epsilon). Any ABSOLUTE cosine cutoff (e.g. `cos > 0.5` to drop "irrelevant" results) would silently break under granite. This task proves none exists. The checklist names `recall-service.ts` and `cosine.ts` too.

**Files:** none changed (audit only).

- [ ] **Step 1: Grep for absolute cosine thresholds**

Run:
```bash
rg -n "cosine|\bcos\b|similarity|0\.[0-9]+|threshold|cutoff|score *[<>]=?" src/core src/adapters src/offscreen/sqlite-worker.ts src/offscreen/worker-vector-store.ts
```

- [ ] **Step 2: Confirm every cosine site is relative, not an absolute gate**

Verify against this checklist (the cosine/score sites in the retrieval path):
- `src/core/rrf.ts` — fusion is `1/(k+rank)`, RANK-based. No cosine compared to a constant. RELATIVE. OK.
- `src/core/ranking.ts` `topPagesBySnippet` — sorts by `score` desc and slices top-k. No absolute floor. RELATIVE. OK.
- `src/core/ranking.ts` `chooseSnippetChunk` — compares `c.cos >= maxCos - epsilon` (a delta from THIS query's max) and `proseScore(text) >= SNIPPET_TAU` (a TEXT score, not cosine). RELATIVE. OK.
- `src/core/ranking.ts` constants — `SNIPPET_EPSILON=0.03` relative delta; `SNIPPET_TAU=0.35` prose-text threshold; `LEXICAL_RRF_WEIGHT=2` rank weight; `CANDIDATE_PAGE_LIMIT=50` count. None an absolute cosine gate. OK.
- `src/core/cosine.ts` — defines `cosineSimilarity` only; holds no threshold constant. It is a pure metric, the input to the relative rankers. OK.
- `src/core/recall-service.ts` — orchestrates query-embed -> `store.search` -> returns ranked results; applies no cosine floor of its own. OK.
- `src/adapters/memory-vector-store.ts` / `src/offscreen/sqlite-worker.ts` `search` — push ALL embedded chunks (only `vector === null` / `vector IS NULL` is skipped) into the rankers; no `cos > X` filter. RELATIVE. OK.

Expected: the grep surfaces ONLY the sites above, every one relative/non-cosine. If any NEW site compares a cosine value to an absolute constant to DROP a result, stop and report it — that is a real break under granite and must be removed before shipping.

- [ ] **Step 3: Record the audit result (commit message only; no file change)**

```bash
git commit --allow-empty -m "chore: cosine-floor audit (incl. recall-service, cosine.ts) - ranking is relative-only, safe for granite"
```

---

### Task 12: Default the eval to granite + first self-quant quality measurement

> **(C1 corollary):** this is the FIRST quality measurement of OUR self-quantized artifact through the eval. The A/B in `docs/embedding-ab-results.md` ran on the COMMUNITY quant via **onnxruntime-node** (CPU int8) — a different file AND a different runtime from onnxruntime-web. So matching the A/B is the goal, but a divergence here is a real signal about our quant, not noise to wave away. (I1c): state the corpus-size budget the A/B actually validated.

**Files:**
- Modify: `eval/lib/embed-node.mjs`

- [ ] **Step 1: Change the bundled-model defaults**

```javascript
const BUNDLED = 'granite' // bundled prod model dir under public/models/ (granite-107m R1)
const MODEL = process.env.EVAL_MODEL || BUNDLED
const DTYPE = process.env.EVAL_DTYPE || 'q8'
const PREFIX = process.env.EVAL_PREFIX || 'none' // granite takes raw text (no e5 prefix)
```

(Granite ships a standard `onnx/model_quantized.onnx`, so no `EVAL_MODEL_FILE` is needed.)

- [ ] **Step 2: Ensure the committed granite is present (LFS), then run the eval**

```bash
git lfs pull                # materialize the committed weights if they are pointer stubs
npm run eval:fetch-model    # now a verifier - confirms the committed bytes' hashes
rm -rf eval/.cache/embeds
npm run eval -- --strip --min-prose=0.35
```

- [ ] **Step 3: Confirm the numbers — and treat divergence as a real signal**

Expected (matches `docs/embedding-ab-results.md`, directional given the small n):
- No combo collapses to P@1 0.00 — in particular **EN->KO P@1 stays ~0.40** (R2/EmbeddingGemma fail here; R1 must not).
- KO->EN is non-zero (~P@1 0.40 / R@5 0.80), the old e5 weak spot fixed.
- EN->EN is preserved (not regressed toward 0.14).
- Reference-snippet rate (`refRate`) is 0.

If a combo collapses or numbers drift materially from the A/B, STOP and investigate the QUANT: this eval runs our optimum-avx2 q8 file, which the A/B never measured (it used the community file on onnxruntime-node). A drift may mean our quant config lost cross-lingual quality — re-check Task 5's `AutoQuantizationConfig`. Do not ship on the assumption that "the model is fine because the A/B said so."

> **Corpus-size budget (I1c).** The A/B verdict rests on a SMALL set: ~5-16 queries per language combo over 27 fixtures. That validates retrieval QUALITY at tens of documents, NOT re-index TIME or quality at scale. So: the gradual re-index keeps search alive on big corpora, but its total wall-time is unmeasured beyond this budget and can be many minutes on WASM. A wider multi-domain golden set run BEFORE and AFTER the swap is the right way to raise confidence past this budget; it is a follow-up, not a blocker, because R1 already has no broken combo.

- [ ] **Step 4: Commit**

```bash
git add eval/lib/embed-node.mjs
git commit -m "eval: default to granite-107m R1; first self-quant quality measurement"
```

---

### Task 13: Retarget the cross-lingual node test to bundled granite

> **v3 (was I4):** `tests/core/embedding-model.node.test.ts` loads `Xenova/multilingual-e5-small` with `query:`/`passage:` prefixes — it asserts the e5 model, which is now REMOVED. The cross-lingual guard must run on granite (the only shipped model, no prefix). The v2 "keep a small e5 sanity check" step is DROPPED — e5 is gone, so a test loading it would fail (the weights are no longer bundled).

**Files:**
- Modify: `tests/core/embedding-model.node.test.ts`

- [ ] **Step 1: Retarget the cross-lingual tests to bundled granite (no prefix)**

Point the loader at the bundled granite dir under `public/models/granite` (the same artifact the extension ships) with `dtype:'q8'` and NO prefix, and keep the two cross-lingual assertions (English query closest to the matching English passage; Korean query closest to the matching English passage) plus the 384-dim check. This makes the node test guard the REAL production model on a real runtime (onnxruntime-node), mirroring the eval default.

```typescript
// Scenario: the bundled model (granite) must place a Korean/English query closer to the
// matching English passage than to an unrelated one - with NO e5-style prefix. If this fails,
// cross-lingual search is broken on the model we actually ship.
// Coverage: integration (real granite inference from the bundled artifact, no mock).
```

(Load via the local bundled path, e.g. point `env.localModelPath` at `public/models/` and load `'granite'` with `{ dtype: 'q8' }`, or load the dir directly — match however other node-side bundled-model loads in this repo resolve `public/models/`. Embeds use raw text: `embed('what hormone wrecks my sleep')`, `embed('cortisol disrupts REM sleep')`, etc. Korean: `embed('잠을 망치는 호르몬')`. The non-ASCII Korean is intentional and already allowed in this file by its existing comment.)

- [ ] **Step 2: Remove any e5 references in this file**

Delete the old e5 loader, the `query:`/`passage:` prefixes, and the `Xenova/multilingual-e5-small` id from this test — e5 is no longer bundled, so nothing here may reference it.

- [ ] **Step 3: Run the node test**

Run: `npx vitest run tests/core/embedding-model.node.test.ts`
Expected: PASS — granite cross-lingual guard holds on the bundled artifact; no e5 reference remains.

- [ ] **Step 4: Commit**

```bash
git add tests/core/embedding-model.node.test.ts
git commit -m "test(core): retarget cross-lingual node guard to bundled granite; drop e5"
```

---

### Task 14: e2e — granite loads + retrieves; gradual re-index; matching version no-storm

> Proven by unit tests: the version decision (Task 1), per-page clear (Task 2), gradual re-embed + progress (Task 3). This e2e covers the real-runtime risks Vitest cannot: (a) our first-party granite artifact actually loads and retrieves through the real offscreen WebGPU/WASM path; (b) a relaunch on a MATCHING version does NOT re-index (a buggy migration that re-clears every launch would wipe vectors); (c) during a re-index, already-re-embedded pages stay searchable (the gradual guarantee).

**Files:**
- Create: `tests/e2e/granite-reindex.spec.ts`

- [ ] **Step 1: Write the e2e**

Reuse the launch/extId/recall/seed helper shape from the existing passing spec (`tests/e2e/hybrid-search.spec.ts`) — align the `sendMessage` envelope (`channel`/`op`) with it rather than guessing.

```typescript
// tests/e2e/granite-reindex.spec.ts
import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')
const PROFILE = path.join(os.tmpdir(), 'recall-granite-reindex-e2e-profile')

async function launchCtx() {
  return chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
}

async function getExtId(ctx: Awaited<ReturnType<typeof launchCtx>>): Promise<string> {
  const swPromise = ctx.waitForEvent('serviceworker', { timeout: 30000 }).catch(() => null)
  const sw = ctx.serviceWorkers()[0] ?? (await swPromise)
  if (!sw) throw new Error('service worker never started')
  return sw.url().split('/')[2]
}

async function recall(ctx: Awaited<ReturnType<typeof launchCtx>>, extId: string, query: string) {
  const page = await ctx.newPage()
  await page.goto(`chrome-extension://${extId}/src/offscreen/offscreen.html`).catch(() => {})
  const ids = await page.evaluate(async (q) => {
    const res = await chrome.runtime.sendMessage({
      channel: 'offscreen-rpc',
      payload: { op: 'recall', text: q, k: 5 },
    })
    return (res?.results ?? []).map((r: any) => r.page.id)
  }, query)
  await page.close()
  return ids as string[]
}

async function seedAndWait(ctx: Awaited<ReturnType<typeof launchCtx>>, extId: string) {
  const page = await ctx.newPage()
  await page.goto(`chrome-extension://${extId}/src/offscreen/offscreen.html`).catch(() => {})
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({
      channel: 'offscreen-rpc',
      payload: {
        op: 'capture-text',
        url: 'http://example.test/bacteria',
        title: 'Bacteria',
        text: 'Bacteria are microscopic single-celled organisms studied in microbiology.',
      },
    })
  })
  await page.close()
  await expect
    .poll(async () => (await recall(ctx, extId, 'microbiology bacteria')).length, { timeout: 120000 })
    .toBeGreaterThan(0)
}

test('granite loads on the real path and retrieves a captured page', async () => {
  test.setTimeout(360000)
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true })

  const ctx = await launchCtx()
  try {
    const extId = await getExtId(ctx)
    await seedAndWait(ctx, extId)
    const ids = await recall(ctx, extId, 'microbiology bacteria')
    expect(ids.length).toBeGreaterThan(0)
  } finally {
    await ctx.close()
  }
})

test('relaunch on a matching version is searchable immediately (no re-index storm)', async () => {
  test.setTimeout(360000)
  // Reuses the PROFILE seeded by the previous test (granite recorded as the version). If the
  // migration wrongly re-cleared on launch, the page would be pending and this would return
  // nothing.
  const ctx = await launchCtx()
  try {
    const extId = await getExtId(ctx)
    await expect
      .poll(async () => (await recall(ctx, extId, 'microbiology bacteria')).length, { timeout: 15000 })
      .toBeGreaterThan(0)
  } finally {
    await ctx.close()
  }
})
```

> The "already-done pages stay searchable mid re-index" property is exercised at unit level by the `peakPending===1` assertion in Task 3 (the migration never blanks more than one page). A multi-page e2e that forces a version bump and queries mid-drain is a good additional test but is timing-fragile; the unit guarantee is the load-bearing proof. If added, seed 3+ pages, bump the stored version, relaunch, and assert an EARLY query already returns the first-migrated page before the drain finishes.

- [ ] **Step 2: Build the extension so the e2e loads granite**

Run: `git lfs pull` (if needed) then `npm run build`
Verify: `ls dist-ext/models/granite/onnx/model_quantized.onnx` (public copied verbatim) AND `! ls dist-ext/models/Xenova 2>/dev/null` (e5 is gone — no leftover e5 dir bundled).

- [ ] **Step 3: Run the e2e**

Run: `npx playwright test tests/e2e/granite-reindex.spec.ts`
Expected: both tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/granite-reindex.spec.ts
git commit -m "test(e2e): granite loads + retrieves; matching-version relaunch does not re-index"
```

---

### Task 15: Final verification + plan-doc commit

- [ ] **Step 1: Full unit suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all PASS.

- [ ] **Step 2: Confirm no probe / e5 / stray-prefix residue**

Run:
```bash
rg -n "granite-probe|__graniteProbe|model_qint8_arm64" src scripts eval tests
rg -n "multilingual-e5-small|Xenova" src scripts eval tests manifest.config.ts
rg -n "query: |passage: " src scripts eval tests
```
Expected:
- NO probe/community-file references anywhere.
- NO `multilingual-e5-small` / `Xenova` references in shipped code (e5 is fully removed). The only acceptable `Xenova` mention is the `.gitignore` line that keeps a stale local e5 copy from being re-committed.
- NO `query: `/`passage: ` prefixes anywhere in `src`/`scripts`/`tests`. (If the eval retains a dormant opt-in A/B branch, it must be gated behind `EVAL_PREFIX` and default to `none` — confirm any hit there is opt-in, not applied by default.)

- [ ] **Step 3: Commit the plan document**

```bash
git add docs/superpowers/plans/2026-06-30-granite-model-swap.md
git commit -m "docs(plan): granite swap plan v3 - granite-only (no e5 fallback) + Git-LFS bundled artifact (no external host)"
```

---

## Self-Review

**1. Spec coverage**
- Bundle granite SAFE artifact (re-quantize IBM official) + COMMIT via Git LFS + build copy + REMOVE e5 + repurpose fetch-model as verifier + remove probe -> Tasks 5, 6, 9 (probe), 14 Step 2 (build copy).
- Probe OUR artifact under the production invocation BEFORE the swap, gating it (C1, now passed in node smoke) -> Task 7; eval admits first self-quant measurement -> Task 12.
- Embedder swap (granite ONLY, no prefix, WebGPU-primary/WASM-fallback + WASM-degraded sink, both-providers-fail rejects -> offscreen "unavailable", cache off, stale header) -> Tasks 8, 9.
- Single version + gradual re-index (per-page clear, re-embed in place, drain re-embeds, write version after all pages; TDD pure pieces) -> Tasks 1, 2, 3 (pure, RED-first), 4 (worker), 9 (wire after load).
- Re-index UX: gradual not dark + real "N of M" denominator + WASM/unavailable notice -> Task 3 (page-by-page), Task 9 (emit total + degraded/unavailable rpc-event), Task 10 (relay both through the SW). UI consume is an explicit one-line follow-up.
- Cosine-floor audit (incl. recall-service.ts, cosine.ts) -> Task 11.
- e5 node test retargeted to granite (e5 check dropped); residue grep extended to e5 + prefixes -> Tasks 13, 15.
- Committed-not-fetched artifact + Git LFS + .gitattributes + .gitignore + manifest comment -> Task 6. tokenizer.json assertion -> Task 5.
- File Map, Self-Review, Tradeoffs -> present.

**2. Placeholder scan**
- The only fill-ins are the two JSON-file SHA-256 in Task 6's verifier (`config.json` `624bd250...`, `tokenizer_config.json` `a572845c...`) and the IBM `REVISION` SHA in Task 5. The two large files' full digests are already pinned (`onnx/model_quantized.onnx` `08da7a65...`, `tokenizer.json` `14917dd7...`). These are generated artifacts (run `scripts/quantize-granite.py`, paste the printed digests) — the same pattern as a lockfile hash, not lazy placeholders. Every other step has complete code/commands.

**3. Type consistency**
- `clearVectorsForPage(pageId: string): Promise<void>` — same name on `VectorSearchPort` (Task 2), `MemoryVectorStore` (Task 2), `WorkerVectorStore` (Task 4), worker op (Task 4), and `migrateEmbeddingModel`'s `Pick<...,'clearVectorsForPage'|'recentPages'>` (Task 3). Consistent.
- `getEmbedVersion()`/`setEmbedVersion(version)` — same on `SettingsPort` (Task 4), `WorkerSettingsStore` (Task 4), worker ops (Task 4), and `EmbedVersionStore` (Task 3). `WorkerSettingsStore` structurally satisfies `EmbedVersionStore`, so Task 9 passes `settings` directly. Consistent.
- `EMBED_MODEL_VERSION`/`needsReindex` — defined Task 1; imported by Task 3 (`embed-migration`) and Task 9 (`offscreen`). Single id, no per-model picker. Consistent.
- Embedder: `MODEL_ID='granite'` matches `public/models/granite` (Task 6) + eval `BUNDLED='granite'` (Task 12) + node test (Task 13). `setDegradedSink((info:{device:'wasm'})=>void)` (Task 8) wired in Task 9; the harder "unavailable" comes from `ensureLoaded()` rejection (Task 8) handled in Task 9's `.catch`. No `embedder.model` field anymore (granite-only). Consistent.
- Re-index progress: offscreen emits `indexing-progress` with `total` (Task 9); SW relays `total` via `broadcastIndexingProgress(pending, embedded, total?)` (Task 10). `embedder-degraded` carries `state:'wasm'|'unavailable'` (Tasks 9, 10). Consistent; additive (panel ignores unknown fields until the follow-up).

No gaps found.

---

## Tradeoffs

- **granite-only — a no-WebGPU/no-WASM device gets NO search (reverses v2's e5 fallback).** v2 kept e5 bundled so the embedder could always load SOMETHING; v3 drops it for a lean ~124MB bundle (vs ~260MB with e5). The cost: a device where granite cannot be created on EITHER WebGPU or WASM has no on-device embedder at all, so search is unavailable there. We ACCEPT this because (a) the probe (Task 7) passed our q8 artifact on both WebGPU and forced-WASM, so a total failure means a genuinely incapable device, which is rare; (b) capture still stores chunks (NULL vectors), so the data is preserved and becomes searchable if the user later opens the profile on capable hardware; (c) the side panel shows an explicit "search unavailable on this hardware" notice (the `embedder-degraded` `state:'unavailable'` event), so the user is never left with capture silently piling up unsearchable chunks. The single-model design also removes v2's per-model version branching and mixed-vector risk entirely: there is one model, one version, one vector space.
- **Git LFS dependency vs git bloat (D2).** Committing the ~124MB artifact directly (the owner's call — no external host, no build-time fetch, fully reproducible from the pinned recipe) costs repo size. Recommended path: Git LFS, so day-to-day clones stay lean and only `git lfs pull` materializes the weights — at the cost of a real new build/CI dependency (`git lfs install` + `git lfs pull`, and a verifier that fails clearly when LFS wasn't pulled). The plain-commit alternative needs no tooling but puts ~124MB in git history forever, bloating every clone now and retroactively. We recommend LFS and leave the final pick to the owner (Task 6 Step 1). Either way the build no longer touches the network for the model — strictly better than v2's host fetch, which could 401/404 and break CI.
- **~124MB bundle.** The shipped extension carries the granite weights (~107MB model + ~17MB tokenizer + tiny configs). This is the floor for a private, fully on-device cross-lingual embedder; there is no smaller R1 quant that keeps EN->KO alive (R2 is smaller but collapses that combo). Accepted as the price of the privacy + cross-lingual guarantee.
- **Probe-our-artifact gate adds a manual step (C1).** The swap blocks on a human running `__graniteProbe()` against OUR `model_quantized.onnx` on both WebGPU and forced-WASM. A node smoke run already passed (GO), so this is now a confirmation rather than an unknown — but only the real browser runtime proves the WebGPU EP, so the manual gate stays. The cost is one manual gate; the benefit is not shipping an artifact that silently fails to load for users.
- **Gradual re-index is mixed-model during the window (M1).** While the migration walks the corpus page by page, already-migrated pages hold granite vectors and not-yet-migrated pages still hold old e5-era ones; a query (embedded with granite) scores the old pages as noise. This window is bounded (it shrinks as the drain proceeds, and the query lane is prioritized so it finishes fast) and self-heals once every page is migrated. We ACCEPT and DOCUMENT this rather than hard-gating `recall` during the migration, because gating would re-introduce the very "search is dark" failure I1 set out to kill — the whole point of going page-by-page is that already-done pages serve good results immediately. If the cross-model noise proves bad in practice, the minimal mitigation is to gate `recall` to return an "updating" state until the migration's `setEmbedVersion` lands; noted for a later contributor.
- **Re-index time on large corpora (I1c budget).** The migration re-embeds every chunk, page by page. Search stays mostly alive (only the in-flight page is briefly pending), but the TOTAL wall-time on a big profile is unmeasured: the A/B validated quality at ~tens of documents (27 fixtures, ~5-16 queries/combo), not re-index time at scale, and WASM-only devices are much slower. The drain is incremental + resumable, the query lane is prioritized, and the IndexingIndicator now shows a real "N of M" bar, so the UI never looks broken — but a large corpus on WASM can still take many minutes. A wider golden set run before/after is the way to extend confidence past this budget.
- **WebGPU vs WASM performance (I2).** Granite on WebGPU is the ideal. A device without WebGPU falls to WASM single-thread (slower); v3 surfaces that as an `embedder-degraded` `state:'wasm'` event to the side panel (consumed by a one-line UI follow-up) instead of a buried console.warn, so the user understands why indexing/search is slow. A device that loads WebGPU only intermittently could thrash, but the persisted version is unchanged by device flips (one model id), so a WebGPU<->WASM flip never triggers a re-index — only an actual model-version bump does.
- **Granite's high cosine floor.** Unrelated pairs sit at ~0.56-0.65 cosine. Ranking is unaffected because it is relative (Task 11 audit), but any future feature wanting an ABSOLUTE "is this relevant at all?" gate (e.g. "no results" detection) must NOT reuse an e5-era cosine constant — it needs its own granite-calibrated threshold. Documented so a later contributor is not bitten.

# Granite Embedding Model Swap + Gradual Re-Index Migration Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **v2 (adversarial-review fixes).** v1 shipped a swap whose runtime proof was on the COMMUNITY quant, deleted the only fallback, and went fully dark during re-index. v2: (C1) gate the swap on a probe of OUR first-party artifact under the PRODUCTION invocation; (C2) keep e5 bundled as a per-device fallback so a granite load failure never makes the product unsearchable; (I1) re-index page-by-page so search is gradual, not dark, with a real "N of M" denominator; plus host/tokenizer/eval/test fixes. See each task's `> v2` note.

**Goal:** Make the bundled embedding model `granite-embedding-107m-multilingual` (R1) the primary, so Korean<->English cross-lingual search works without breaking the majority EN->EN case — while keeping the current `Xenova/multilingual-e5-small` bundled as a safety fallback. On a model change, re-embed every stored chunk **gradually** (page by page) so search degrades smoothly instead of going blank.

**Architecture:** Granite is the same 384-dim space as e5, so the vector store schema and ranking are unchanged. The swap is: (1) bundle a SAFE first-party granite ONNX (we re-quantize IBM's official fp32 ONNX ourselves, never the community quant) **alongside** the existing e5 model; (2) the embedder tries granite first and falls back to e5 only if granite's pipeline cannot be created on this device — it records which model ACTUALLY loaded; (3) persist an embedding-model **version keyed on the actually-loaded model** in settings and, when it changes, re-embed the corpus **one page at a time**, overwriting each page's vectors in place so already-re-embedded pages stay searchable the whole time. The re-index reuses the existing `runDrainWithProgress()` broadcast plus a small additive `total` field so the side panel can show real progress.

**Tech Stack:** TypeScript, Preact, `@huggingface/transformers` (transformers.js, WebGPU primary / WASM fallback), SQLite-WASM over OPFS in a worker, Vitest (unit), Playwright (e2e), Vite + CRXJS (build), Python `optimum`/`onnxruntime` (offline re-quantize recipe).

---

## Background the engineer needs

Read these before starting. They are the load-bearing facts.

- **Why granite, why R1, why a re-index:** `docs/embedding-ab-results.md`. R1 is the only candidate with no broken language combo (keeps EN->KO alive), best overall MRR, 384-dim (no schema change). R2 and EmbeddingGemma collapse EN->KO to P@1 0.00 and are rejected. **CAUTION (v2):** the A/B numbers and the spike probe (`device=webgpu dims=384 cos(bacteria, 박테리아)=0.698`) were measured on the **COMMUNITY** quant (`gety-ai .../model_qint8_arm64.onnx`), NOT on the artifact we will ship. The A/B's eval also ran on **onnxruntime-node** (CPU int8), which is a different runtime from **onnxruntime-web** (WASM/WebGPU). So those numbers are evidence the MODEL is right, not proof OUR file loads or scores the same. Task 7 (probe) and Task 12 (eval) are the FIRST measurements of our own artifact.
- **The embedder:** `src/offscreen/webgpu-embedder.ts`. It runs the model in the offscreen document, WebGPU first and WASM single-thread as fallback, with a two-lane (query=high priority / passage=low priority) single-flight scheduler. e5 needs `query: ` / `passage: ` prefixes; **granite uses none** (raw `input_ids` + `attention_mask`). In v2 the embedder gains a SECOND fallback axis: model (granite -> e5), orthogonal to the existing device (webgpu -> wasm) one.
- **How weights are bundled:** `scripts/fetch-model.mjs` downloads files from a pinned HuggingFace commit into `public/models/.../` and hash-verifies each one (deletes + fails the build on mismatch). `public/models/` is gitignored (`.gitignore:12`). Vite copies `public/` verbatim into the build `outDir` (`dist-ext` for `npm run build`), so `public/models/...` becomes `dist-ext/models/...`. In v2 it fetches BOTH granite (first-party) and e5 (kept as fallback).
- **The drain (re-index engine):** `src/core/indexing-service.ts`. `drain()` loops `store.pendingChunks(batch)` (chunks whose `vector IS NULL`) and embeds them. **Setting a chunk's vector back to NULL re-queues it for the drain.** That is the migration mechanism — but in v2 we null ONE PAGE at a time, not the whole corpus, so only that page is briefly unsearchable.
- **Storage:** `src/offscreen/sqlite-worker.ts` (`chunks` table with a `vector BLOB NULL` column; `settings` key/value table), surfaced through `src/offscreen/worker-vector-store.ts` and `src/offscreen/worker-settings-store.ts` over `src/offscreen/sqlite-worker-client.ts`. The in-memory twin used in tests and the eval is `src/adapters/memory-vector-store.ts`; the two engines are kept byte-for-byte equivalent (ADR 0020).
- **Ranking is relative, not cosine-thresholded:** `src/core/rrf.ts` (rank-based fusion), `src/core/ranking.ts` (`topPagesBySnippet` ranks by relative score; `chooseSnippetChunk` compares to `maxCos - epsilon`, a RELATIVE delta; `SNIPPET_TAU` is a prose-text threshold, not cosine), `src/core/cosine.ts`, `src/core/recall-service.ts` (orchestrates query-embed -> store.search; holds no cosine constant). Granite's unrelated-pair cosine floor is high (~0.56-0.65), so any ABSOLUTE cosine cutoff would break — Task 11 audits that none exists.
- **The throwaway probe:** `src/offscreen/offscreen.ts` has a `granite-probe` RPC op, a `runGraniteProbe()` function, and a `__graniteProbe` global. In v2 Task 7 RE-POINTS this probe at OUR first-party file under the production invocation (it currently loads the community file) and uses it as the swap GATE; Task 9 deletes it afterward.
- **Parallel work — coordinate, mostly untouched:** another task owns `src/ui/*` and `manifest.config.ts`. v2 deliberately reuses the EXISTING `indexing-progress` / `indexing-complete` broadcast (offscreen -> SW -> panel). It needs ONE small ADDITIVE edit to `src/background/index.ts` (Task 10): carry a `total` field through the relay and relay a new `embedder-degraded` event. No `src/ui/*` edits — consuming those fields in the IndexingIndicator is a one-line follow-up the parallel task can pick up. Flag this to the SW owner.

---

## File Map

**Create:**
- `src/core/embed-version.ts` — pure: the per-model version identifiers (`EMBED_VERSION_GRANITE`, `EMBED_VERSION_E5`), a `versionForModel()` helper, and the `needsReindex()` decision.
- `src/core/embed-migration.ts` — pure orchestration: `migrateEmbeddingModel(store, versions, current, reembedPending, onProgress)` — page-by-page null + re-embed + record version, emitting `{done,total}` progress.
- `tests/core/embed-version.test.ts` — unit tests for `needsReindex`, `versionForModel`, and the version constants.
- `tests/core/embed-migration.test.ts` — integration tests over the REAL `MemoryVectorStore` + real `IndexingService` + a fake embedder + a fake version store; asserts gradual (never all-dark) re-embed and progress.
- `scripts/quantize-granite.py` — the SAFE re-quantize recipe (IBM official fp32 ONNX -> first-party `model_quantized.onnx`), pinned + hash-printing + `tokenizer.json` assertion.
- `tests/e2e/granite-reindex.spec.ts` — e2e: granite loads + retrieves on the real extension path; a relaunch on a matching version does NOT re-index; a re-index keeps already-done pages searchable.

**Modify:**
- `src/offscreen/webgpu-embedder.ts` — granite PRIMARY + e5 FALLBACK (record which loaded), conditional prefix (e5 only), `env.useBrowserCache=false`, degraded/fallback signal hook, stale file header (M2).
- `tests/core/webgpu-embedder.test.ts` — granite-no-prefix assertions; e5-fallback assertions.
- `src/core/ports.ts` — add `clearVectorsForPage(pageId)` to `VectorSearchPort`; add `getEmbedVersion()`/`setEmbedVersion()` to `SettingsPort`.
- `src/adapters/memory-vector-store.ts` — implement `clearVectorsForPage()`.
- `tests/core/memory-vector-store.test.ts` — test `clearVectorsForPage()`.
- `src/offscreen/sqlite-worker.ts` — `clearVectorsForPage`, `getEmbedVersion`, `setEmbedVersion` ops + handlers.
- `src/offscreen/worker-vector-store.ts` — `clearVectorsForPage()` passthrough.
- `src/offscreen/worker-settings-store.ts` — `getEmbedVersion()`/`setEmbedVersion()` passthrough.
- `src/offscreen/offscreen.ts` — Task 7: re-point the probe at OUR file (gate); Task 9: remove the probe + run `migrateEmbeddingModel(...)` after the model loads (so the version is keyed to the loaded model), then drain; emit re-index `total` and `embedder-degraded` events.
- `src/background/index.ts` — minimal additive relay: pass a `total` field through `indexing-progress`; relay a new `embedder-degraded` event (I2).
- `scripts/fetch-model.mjs` — fetch the FIRST-PARTY granite artifact set (public, permanent, unauthenticated host) ALONGSIDE the existing e5 set (e5 kept as fallback).
- `eval/lib/embed-node.mjs` — default the eval to granite (bundled id + `none` prefix).
- `tests/core/embedding-model.node.test.ts` — retarget the cross-lingual guard to the bundled granite (no prefix); keep a small e5-fallback sanity check (I4).

---

### Task 1: Pure version identifiers (per loadable model) + re-index decision

> **v2:** the version is no longer a single constant. Because e5 stays as a per-device fallback (C2) and granite+e5 vectors are incompatible, the persisted version must name WHICH model actually embedded this profile. So we ship one id per loadable model and pick at runtime by the model that loaded.

**Files:**
- Create: `src/core/embed-version.ts`
- Test: `tests/core/embed-version.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/embed-version.test.ts
import {
  needsReindex,
  versionForModel,
  EMBED_VERSION_GRANITE,
  EMBED_VERSION_E5,
} from '../../src/core/embed-version'

// Scenario: a profile that last embedded with a different (or no) model must trigger a
// re-index; a profile already on the same model must not. The "same model" check is what
// keeps a granite-loaded device from re-indexing on every launch.
// Coverage: integration (the real pure decision function).
test('needsReindex is true for a null or different stored version, false when equal', () => {
  expect(needsReindex(null, EMBED_VERSION_GRANITE)).toBe(true)
  expect(needsReindex(EMBED_VERSION_E5, EMBED_VERSION_GRANITE)).toBe(true)
  expect(needsReindex(EMBED_VERSION_GRANITE, EMBED_VERSION_GRANITE)).toBe(false)
})

// Scenario: the embedder reports which model actually loaded ('granite' on most devices,
// 'e5' when granite could not be created here). The persisted version MUST match that model
// so the corpus is embedded with exactly one model per device (no mixed-vector garbage).
// Coverage: integration (locks the model -> version mapping).
test('versionForModel maps the loaded model to its version id', () => {
  expect(versionForModel('granite')).toBe(EMBED_VERSION_GRANITE)
  expect(versionForModel('e5')).toBe(EMBED_VERSION_E5)
})

// Scenario: the version strings are the single source of truth shared by the embedder, the
// migration, and the eval default. A typo silently disables the migration.
// Coverage: integration (locks the literal values).
test('version ids are the granite r1 q8 and e5 q8 identifiers', () => {
  expect(EMBED_VERSION_GRANITE).toBe('granite-107m-r1-q8-v1')
  expect(EMBED_VERSION_E5).toBe('e5-small-q8-v1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/embed-version.test.ts`
Expected: FAIL — cannot resolve `../../src/core/embed-version`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/embed-version.ts
// The bundled embedding models' identities, persisted per-profile so a model swap (or a
// per-device fallback to e5) can trigger a re-index. Bump the trailing -vN whenever the
// SHIPPED weights for a model change in a way that makes old vectors incomparable (new
// dtype, new dims): the offscreen migration compares the loaded model's id to the stored
// value and re-embeds the corpus on a mismatch.
export const EMBED_VERSION_GRANITE = 'granite-107m-r1-q8-v1'
export const EMBED_VERSION_E5 = 'e5-small-q8-v1'

// Which model the embedder actually loaded on this device. granite is primary; e5 is the
// fallback the embedder uses only when granite's pipeline cannot be created here.
export type LoadedModel = 'granite' | 'e5'

// The persisted version id for the model that actually loaded. The migration uses THIS as
// `current`, so the whole corpus is embedded with one model per device.
export function versionForModel(model: LoadedModel): string {
  return model === 'granite' ? EMBED_VERSION_GRANITE : EMBED_VERSION_E5
}

// True when the stored version is missing or differs from the current one, i.e. a re-index
// is required. Pure: the offscreen wires the real settings + store around this decision.
export function needsReindex(stored: string | null, current: string): boolean {
  return stored !== current
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/embed-version.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/embed-version.ts tests/core/embed-version.test.ts
git commit -m "feat(core): per-model embedding-version ids + versionForModel + needsReindex"
```

---

### Task 2: `clearVectorsForPage` on the port + in-memory store

> **v2:** replaces v1's `clearAllVectors`. Nulling the WHOLE corpus at once made search blank until the whole drain finished (I1). The migration now nulls ONE page at a time, so only that page is briefly unsearchable while every other page keeps serving results.

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

> **v2:** the migration drives the re-index PAGE BY PAGE (I1). For each page it nulls that page's vectors then re-embeds the now-pending chunks via the injected drain, so already-done pages stay searchable and a real `{done,total}` denominator falls out. It is interrupt-safe: the version is recorded only after every page is done, so a crash mid-run just re-runs the (idempotent) loop next launch.

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

// Scenario: the model changed since this profile was last indexed. Every page must be
// re-embedded with the new model and the new version recorded - but page by page, never
// blanking the whole corpus at once.
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

// Scenario: a profile already on the current model reopens the extension. The migration must
// be a no-op: it must NOT clear durable vectors and force a needless re-embed every launch.
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
// with the loaded model - but ONE PAGE AT A TIME so search stays mostly alive. For each page
// we null its vectors (only that page leaves search) and immediately re-embed the now-pending
// chunks via `reembedPending` (the offscreen passes the real drain), so the page is searchable
// again before we touch the next one. `onProgress` reports {done,total} pages for the UI bar.
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

> **Why this exists.** The spike loaded `gety-ai/...`'s community int8 binary. We must NOT bundle an unaudited third-party quant in a privacy extension. Instead we re-quantize IBM's OFFICIAL fp32 ONNX ourselves into a standard-named `onnx/model_quantized.onnx` that transformers.js loads with the normal `dtype:'q8'`. (The A/B noted `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` ships a clean standard quant, but that is R2 — rejected for collapsing EN->KO — so we cannot just grab a clean R2 build.) This script is run once by a maintainer / in CI; its outputs are published to a first-party location and Task 6 fetches + hash-verifies them. It is not part of `npm run build`.
>
> **v2 (I5):** granite R1 is XLM-RoBERTa / SentencePiece. `save_pretrained` writes a transformers.js-loadable `tokenizer.json` ONLY for a FAST tokenizer, and transformers.js loads `tokenizer.json` exclusively. So the recipe FORCES `use_fast=True` and ASSERTS `tokenizer.json` exists after save — if it does not, the script fails loudly instead of publishing an artifact that cannot tokenize in the browser.

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
# published to our first-party model host and pinned by scripts/fetch-model.mjs.
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
REVISION = "main"  # PIN to a commit SHA before publishing (replace "main").
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

# 4. Print SHA-256 of every file Task 6 bundles, to paste into EXPECTED_HASHES.
for rel in ["config.json", "tokenizer_config.json", "tokenizer.json", "onnx/model_quantized.onnx"]:
    path = os.path.join(OUT, rel)
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    size_mb = os.path.getsize(path) / 1e6
    print(f"{rel:34s} {digest}  ({size_mb:.1f} MB)")
```

- [ ] **Step 2: Document the publish + pin step (no code; referenced by Task 6's fetch-model header)**

The maintainer runs the script, then publishes the four files under `dist-model/granite/` to a **PUBLIC, PERMANENT, UNAUTHENTICATED** first-party host (see Task 6, I3) — a PUBLIC HuggingFace repo pinned to a commit SHA, or a tagged GitHub release asset. They record the printed SHA-256 values and replace `REVISION = "main"` with the exact IBM commit SHA used, so the build is reproducible.

- [ ] **Step 3: Commit**

```bash
git add scripts/quantize-granite.py
git commit -m "build: first-party granite re-quantize recipe (IBM official fp32 -> int8, asserts tokenizer.json)"
```

---

### Task 6: Fetch the granite artifact at build time (keep e5 as fallback)

> `npm run prebuild` runs this before every build. It must download our FIRST-PARTY granite artifact (Task 5) and hash-verify each file, exactly like the existing e5 flow — and KEEP fetching e5 too (C2: e5 is the per-device fallback).
>
> **v2 (I3):** the granite host MUST be PUBLIC, PERMANENT, and UNAUTHENTICATED. `fetch-model.mjs` does a tokenless `fetch()`; a PRIVATE HuggingFace repo returns 401 and breaks prebuild and CI forever. So the artifact lives at a public HF repo pinned to a commit SHA, or a tagged GitHub release asset. If a private host is ever mandated, this script must grow a token path (`Authorization: Bearer ${process.env.HF_TOKEN}`) with the token supplied as a CI secret — call that out explicitly rather than silently relying on an unauthenticated fetch.
>
> **v2 (C2):** do NOT delete `public/models/Xenova`. e5 stays bundled as the fallback the embedder loads when granite cannot be created on a device.

**Files:**
- Modify: `scripts/fetch-model.mjs`

- [ ] **Step 1: Refactor to fetch a LIST of models (granite + e5)**

In `scripts/fetch-model.mjs`, replace the single-model `SHA` / `HF_BASE` / `MODEL_DIR` / `EXPECTED_HASHES` / `FILES` block with a per-model array. Keep the existing e5 entry verbatim (same SHA, hashes, dir) and add the first-party granite entry:

```javascript
// Each model: a base resolve URL (PUBLIC + permanent + unauthenticated - this script does a
// tokenless fetch; a private/401 host breaks prebuild and CI forever), the local dir under
// public/models/, and the per-file SHA-256 hashes (a wrong/tampered file is deleted + fails
// the build).
const MODELS = [
  {
    name: 'granite',
    // First-party granite artifact: re-quantized from IBM official fp32 by
    // scripts/quantize-granite.py, then published to our PUBLIC pinned host. NOT the community
    // quant. Replace <FIRST_PARTY_PUBLIC_BASE> with the pinned resolve URL of the published
    // artifact - a PUBLIC HF repo at a fixed commit SHA, or a tagged GitHub release asset base.
    // It MUST be reachable with no auth header. If a private host is ever mandated, add an
    // Authorization: Bearer ${process.env.HF_TOKEN} path here and wire HF_TOKEN as a CI secret.
    base: '<FIRST_PARTY_PUBLIC_BASE>',
    dir: resolve(ROOT, 'public/models/granite'),
    hashes: {
      'config.json':               '<sha256 from quantize-granite.py>',
      'tokenizer_config.json':     '<sha256 from quantize-granite.py>',
      'tokenizer.json':            '<sha256 from quantize-granite.py>',
      'onnx/model_quantized.onnx': '<sha256 from quantize-granite.py>',
    },
    files: ['config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'],
  },
  {
    // KEPT as the per-device fallback (C2). Same pinned commit + hashes as before.
    name: 'e5',
    base: 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    dir: resolve(ROOT, 'public/models/Xenova/multilingual-e5-small'),
    hashes: {
      'config.json':               'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
      'tokenizer_config.json':     'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
      'tokenizer.json':            '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
      'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    },
    files: ['config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'],
  },
]
```

- [ ] **Step 2: Thread the per-model dir/base/hashes through `fetchFile` + the loop**

`fetchFile` currently closes over module-level `MODEL_DIR` / `HF_BASE` / `EXPECTED_HASHES`. Change its signature to take the model: `fetchFile(model, rel)` and inside it use `model.dir`, `model.base`, `model.hashes[rel]`. The bottom loop becomes:

```javascript
console.log('[fetch-model] Checking bundled model files...')
try {
  for (const model of MODELS) {
    for (const rel of model.files) {
      await fetchFile(model, rel)
    }
  }
  console.log('[fetch-model] All model files present and verified. Build may proceed.')
} catch (err) {
  console.error('[fetch-model] FAILED:', err.message)
  process.exit(1)
}
```

- [ ] **Step 3: Run the fetcher**

Run: `npm run eval:fetch-model`
Expected: per-file `done`/`skip ... (hash ok)` lines for BOTH `public/models/granite/...` and `public/models/Xenova/multilingual-e5-small/...`, ending with `All model files present and verified.` (A wrong/tampered file is deleted and the script exits 1. A 401/404 on the granite base means the host is not public/permanent — fix the host, do not add a token unless a private host is deliberately mandated.)

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-model.mjs
git commit -m "build: fetch first-party granite (public host) alongside e5 fallback"
```

---

### Task 7: GATE — probe OUR first-party artifact under the production invocation

> **v2 (C1) — the critical gate.** The spike only proved the COMMUNITY `model_qint8_arm64.onnx` loads via `{dtype:'fp32', model_file_name}`. Production loads OUR optimum-avx2 `model_quantized.onnx` via `dtype:'q8'` — a DIFFERENT op-encoding the onnxruntime-web WASM/WebGPU execution providers may or may not support. This task is the FIRST runtime proof of our own file. It MUST pass before Task 8 (embedder swap). If it fails, our artifact is unshippable as-is: revisit the quant config (Task 5) — do NOT proceed to the swap.

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

If EITHER pass fails to create the pipeline or returns garbage cosines, STOP. Our q8 artifact is not usable on onnxruntime-web; re-check the quant config in Task 5 (try a different `AutoQuantizationConfig` op set) or the published file — do NOT delete e5, do NOT swap the embedder. The whole swap is gated here.

- [ ] **Step 4: Record the gate result (commit message only; no permanent code change — the probe edit is reverted/removed in Task 9)**

```bash
git commit --allow-empty -m "chore: GATE - first-party granite q8 artifact probed OK on WebGPU + forced-WASM (dims=384, KO<->EN cosine sane)"
```

---

### Task 8: Swap the embedder to granite PRIMARY + e5 FALLBACK

> **Gated on Task 7 passing.** v2 (C2): the embedder tries granite first; if granite's pipeline cannot be CREATED on this device, it falls back to e5 (so a granite load failure never makes the product permanently unsearchable). It records WHICH model loaded; the offscreen keys the persisted version on that, so every embed on a device uses exactly one model and the index stays internally consistent. v2 (I2): the fallback / WASM-degraded state is surfaced to the side panel via an rpc-event, not a buried `console.warn`. v2 (M2): fix the stale file header.

**Files:**
- Modify: `src/offscreen/webgpu-embedder.ts`
- Test: `tests/core/webgpu-embedder.test.ts`

- [ ] **Step 1: Update the embedder tests (RED)**

In `tests/core/webgpu-embedder.test.ts`:

(a) Replace the `kind prefix` test (e5 prefixes) with a granite no-prefix test:

```typescript
// Scenario: granite (the primary) takes raw input_ids+attention_mask and must NOT receive
// e5's "query: "/"passage: " prefixes; leaking them poisons every embedding.
// Coverage: integration (fake records the exact strings the model receives).
test('granite primary: raw text (no prefix) reaches the model for both lanes', async () => {
  const fake = makeFake()
  const embedder = new WebGpuEmbedder(fake.factory)

  await embedder.embed(['foo'], 'query')
  await embedder.embed(['bar'], 'passage')

  const flat = fake.calls.flat()
  expect(flat).toContain('foo')
  expect(flat).toContain('bar')
  expect(flat).not.toContain('query: foo')
  expect(flat).not.toContain('passage: bar')
  expect(embedder.model).toBe('granite')
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

(d) Add an e5-fallback test. The fake's `failTimes` counts factory invocations; granite consumes a webgpu+wasm attempt (2 calls), so `failTimes:2` fails ALL of granite and lets the next factory call (e5) succeed:

```typescript
// Scenario: granite cannot be created on this device (e.g. the q8 op-encoding is unsupported
// by the available execution providers). The embedder MUST fall back to e5 so the product is
// still searchable - and then it MUST prefix again, because e5 needs "query:"/"passage:".
// Coverage: integration (fake fails the whole granite attempt; asserts model=e5 + prefixing).
test('e5 fallback: granite load failure falls back to e5 and re-enables prefixes', async () => {
  const fake = makeFake({ failTimes: 2 }) // fail granite on both webgpu and wasm
  const embedder = new WebGpuEmbedder(fake.factory)

  await embedder.embed(['foo'], 'query')

  expect(embedder.model).toBe('e5')
  expect(fake.calls.flat()).toContain('query: foo') // e5 prefixing restored
})
```

> Note: the `poisoned pipe` test (`failTimes:2` then a successful retry) asserted `device==='webgpu'`. With granite->e5 fallback, `failTimes:2` now means "granite failed, e5 loaded". Update that test's expectation to the new behavior: after the first `ensureLoaded()` rejects... it no longer rejects, because e5 succeeds. Re-scope that test to fail BOTH models (e.g. `failTimes:4` = granite webgpu+wasm AND e5 webgpu+wasm) so the first load truly rejects, then a clean retry (the 5th factory call) loads granite. Keep the poisoned-pipe intent; just account for the extra fallback attempts. The `inference failure` and `single-flight` tests are model-agnostic and unchanged.

- [ ] **Step 2: Run the embedder tests to verify they fail**

Run: `npx vitest run tests/core/webgpu-embedder.test.ts`
Expected: FAIL — `embedder.model` does not exist; prefixes still present; no e5 fallback.

- [ ] **Step 3: Implement the embedder swap + fallback**

In `src/offscreen/webgpu-embedder.ts`:

(a) Fix the stale header (M2). Replace the top comment's "runs the multilingual-e5-small model" framing with: granite-107m PRIMARY (raw text, no prefix), e5-small FALLBACK (with `query:`/`passage:` prefixes) when granite cannot be created on this device; still WebGPU-first / WASM-fallback per model; still returns `number[][]` for RPC.

(b) Replace the single `MODEL_ID` constant with a per-model descriptor and a loaded-model field:

```typescript
// Primary: granite, loaded by the bare dir name 'granite' from env.localModelPath
// (public/models/granite/). dtype:'q8' requests onnx/model_quantized.onnx - our FIRST-PARTY
// re-quantized artifact (Task 5/6). Raw text, no prefix.
// Fallback: e5, kept bundled (public/models/Xenova/...). dtype:'q8' too. NEEDS query:/passage:
// prefixes. Used only when granite's pipeline cannot be created on this device. Both are 384-dim.
const GRANITE = { id: 'granite', prefix: false as const }
const E5 = { id: 'Xenova/multilingual-e5-small', prefix: true as const }
```

Add fields + a public getter:

```typescript
  private _model: 'granite' | 'e5' | null = null
  // Which model actually loaded ('granite' primary, 'e5' fallback). Null until loaded.
  get model(): 'granite' | 'e5' | null { return this._model }
```

(c) Add an optional degraded-state sink (mirrors `progressSink`) so the offscreen can surface the device/model to the side panel (I2):

```typescript
  private degradedSink?: (info: { device: 'webgpu' | 'wasm'; model: 'granite' | 'e5' }) => void
  // The offscreen wires this to an 'embedder-degraded' rpc-event. Called once the pipeline is
  // ready whenever the result is anything slower/weaker than the ideal (granite on webgpu):
  // a WASM device OR an e5 fallback. The side panel turns it into a "running slow / unsupported
  // hardware" notice instead of a buried console.warn.
  setDegradedSink(cb: (info: { device: 'webgpu' | 'wasm'; model: 'granite' | 'e5' }) => void): void {
    this.degradedSink = cb
  }
```

(d) Refactor `createPipe()` so it tries one model fully (WebGPU then WASM) and, on total failure, tries the next. Factor the existing WebGPU-then-WASM logic into a helper `loadModel(desc, onProgress)` that returns `{ pipe, device }` and warms up with the right text (raw `'warmup'` for granite; `'query: warmup'` for e5). Then:

```typescript
    // Try granite first; only if its pipeline cannot be created on this device do we fall back
    // to e5. A granite load failure must NEVER leave the product unsearchable (C2).
    let loaded: { pipe: FeatureExtractionPipeline; device: 'webgpu' | 'wasm'; model: 'granite' | 'e5' }
    try {
      const r = await this.loadModel(GRANITE, onProgress)
      loaded = { ...r, model: 'granite' }
    } catch (e) {
      console.warn('[recall] granite unavailable on this device, falling back to e5:', String(e))
      const r = await this.loadModel(E5, onProgress)
      loaded = { ...r, model: 'e5' }
    }
    this._device = loaded.device
    this._model = loaded.model
    // Surface anything less than the ideal (granite on webgpu) to the UI, not just the console.
    if (loaded.device === 'wasm' || loaded.model === 'e5') {
      console.warn(`[recall] DEGRADED embedder: model=${loaded.model} device=${loaded.device}`)
      this.degradedSink?.({ device: loaded.device, model: loaded.model })
    }
    return loaded.pipe
```

(e) In `configureEnv()`, after `env.allowRemoteModels = false`, disable the browser cache:

```typescript
    // We bundle models locally, so transformers.js's browser cache is pointless and, in a
    // chrome-extension context, warns "Cache 'put' ... unsupported". Turn it off.
    env.useBrowserCache = false
```

(f) In `runEmbed()`, prefix ONLY when the loaded model is e5. Replace the unconditional prefix:

```typescript
        const slice = texts.slice(i, i + BATCH)
        const prefixed = slice.map((t) => `${kind}: ${t}`)
```

with:

```typescript
        // granite takes raw text in both lanes; e5 (the fallback) still needs the
        // "query:"/"passage:" prefix. The `kind` always drives the two-lane scheduler
        // priority regardless of model; it only ALTERS the text when e5 loaded.
        const raw = texts.slice(i, i + BATCH)
        const slice = this._model === 'e5' ? raw.map((t) => `${kind}: ${t}`) : raw
```

and use `slice` in the `pipe(...)` call + the perf log (drop the old `prefixed` references).

- [ ] **Step 4: Run the embedder tests to verify they pass**

Run: `npx vitest run tests/core/webgpu-embedder.test.ts`
Expected: PASS — granite raw text + `model==='granite'`; e5 fallback prefixes + `model==='e5'`; priority `['p1','q1','p2']`; batches `[8,8,4]`.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/webgpu-embedder.ts tests/core/webgpu-embedder.test.ts
git commit -m "feat(offscreen): granite primary + e5 fallback, record loaded model, degraded signal, cache off"
```

---

### Task 9: Run the migration on offscreen init + remove the probe

> **v2:** the migration now runs AFTER the model loads, because the persisted version must be keyed to the model that ACTUALLY loaded (granite or the e5 fallback). It re-embeds page by page via the existing drain and reports a `total`. The throwaway probe (re-pointed in Task 7) is deleted here.

**Files:**
- Modify: `src/offscreen/offscreen.ts`

- [ ] **Step 1: Import the migration pieces**

```typescript
import { migrateEmbeddingModel } from '../core/embed-migration'
import { versionForModel } from '../core/embed-version'
```

- [ ] **Step 2: Wire the degraded sink to an rpc-event (I2)**

Near `embedder.setProgressSink(emitModelProgress)`, add:

```typescript
// Surface a degraded embedder (WASM device, or the e5 fallback) to the SW -> side panel as a
// "running slow / unsupported hardware" notice. Consuming this in the IndexingIndicator is a
// one-line UI follow-up (parallel task); the event is emitted here regardless.
embedder.setDegradedSink((info) => {
  chrome.runtime
    .sendMessage({ channel: 'rpc-event', kind: 'embedder-degraded', device: info.device, model: info.model })
    .catch(() => {})
})
```

- [ ] **Step 3: Replace the on-load drain with load -> migrate -> drain**

Replace the on-load `runDrainWithProgress()` (under "On load: resume any pending chunks") with a load-first sequence so we know which model to key the version on, then a gradual migrate, then the normal drain:

```typescript
// On load: (1) load the model so we know which one actually loaded (granite primary, or the
// e5 fallback on a device where granite cannot be created); (2) if that model differs from the
// version this profile was last indexed with, re-embed the corpus PAGE BY PAGE with it - so
// search degrades gradually (already-re-embedded pages keep serving) instead of going blank;
// (3) always run the normal drain afterward to finish any chunks left pending (a fresh capture
// or an interrupted re-index). The migration + drain broadcast indexing-progress (now with a
// `total`), which the side panel renders as the "updating search index N of M" state.
embedder
  .ensureLoaded()
  .then(() => {
    const current = versionForModel(embedder.model ?? 'granite')
    return migrateEmbeddingModel(
      store,
      settings,
      current,
      () =>
        new Promise<void>((done) => {
          // Re-embed the currently-pending chunks (this page's) and resolve when the drain ends.
          indexing.drain((n) => bumpReindexProgress(n)).then(() => done())
        }),
      (p) => emitReindexTotal(p),
    )
  })
  .catch((e) => console.error('[recall/offscreen] embed-model migration failed:', e))
  .finally(() => runDrainWithProgress())
```

> Implementation note: keep this simple. `indexing.drain` is single-flight, so the migration's per-page drain calls are serialized naturally. `bumpReindexProgress`/`emitReindexTotal` are two tiny helpers next to `runDrainWithProgress` that send the existing `indexing-progress` rpc-event with an added `total` field (the page count from `onProgress`). The exact running-count vs total wiring can mirror `runDrainWithProgress`; the load-bearing requirement is that the event now carries a `total` so the panel can show "N of M" (Task 10 relays it).

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
git commit -m "feat(offscreen): load -> version-by-loaded-model -> gradual re-index -> drain; remove granite probe"
```

---

### Task 10: Relay the re-index `total` + degraded event through the SW

> **v2 (I1b, I2):** `broadcastIndexingProgress` sends only a running count, and the WASM/fallback signal was a console.warn no user sees. This is the ONE small additive edit to `src/background/index.ts` (coordinate with its owner). It carries a `total` through `indexing-progress` so the panel can show a real "N of M" bar, and relays a new `embedder-degraded` event. No `src/ui/*` change here — consuming the fields in the IndexingIndicator is the parallel task's one-line follow-up.

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
    // The embedder loaded in a degraded mode (WASM device, or the e5 fallback). Relay to the
    // panel so it can show a "running slow / unsupported hardware" notice. UI consume is a
    // follow-up; this just makes the signal reachable instead of a buried offscreen warn.
    chrome.runtime
      .sendMessage({ type: 'embedder-degraded', device: msg.device, model: msg.model })
      .catch(() => {})
  }
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. (The panel ignores the unknown `total`/`embedder-degraded` fields until the follow-up consumes them — additive and backward-compatible.)

- [ ] **Step 5: Commit**

```bash
git add src/background/index.ts
git commit -m "feat(bg): relay re-index total + embedder-degraded event (additive)"
```

---

### Task 11: Cosine-floor audit (verification)

> Granite's unrelated-pair cosine sits high (~0.56-0.65). Ranking is preserved because it is RELATIVE (RRF rank-based, top-by-score, relative epsilon). Any ABSOLUTE cosine cutoff (e.g. `cos > 0.5` to drop "irrelevant" results) would silently break under granite. This task proves none exists. **v2 (M3):** the checklist now names `recall-service.ts` and `cosine.ts` too.

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

> **v2 (C1 corollary):** this is the FIRST quality measurement of OUR self-quantized artifact. The A/B in `docs/embedding-ab-results.md` ran on the COMMUNITY quant via **onnxruntime-node** (CPU int8) — a different file AND a different runtime from onnxruntime-web. So matching the A/B is the goal, but a divergence here is a real signal about our quant, not noise to wave away. v2 (I1c): state the corpus-size budget the A/B actually validated.

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

- [ ] **Step 2: Ensure the bundled granite is present, then run the eval**

```bash
npm run eval:fetch-model
rm -rf eval/.cache/embeds
npm run eval -- --strip --min-prose=0.35
```

- [ ] **Step 3: Confirm the numbers — and treat divergence as a real signal**

Expected (matches `docs/embedding-ab-results.md`, directional given the small n):
- No combo collapses to P@1 0.00 — in particular **EN->KO P@1 stays ~0.40** (R2/EmbeddingGemma fail here; R1 must not).
- KO->EN is non-zero (~P@1 0.40 / R@5 0.80), the e5 weak spot fixed.
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

### Task 13: Retarget the cross-lingual node test to bundled granite (keep an e5 sanity check)

> **v2 (I4):** `tests/core/embedding-model.node.test.ts` loads `Xenova/multilingual-e5-small` with `query:`/`passage:` prefixes — it asserts the e5 model, which is now the FALLBACK, not the primary. The real cross-lingual guard should run on the PRIMARY (granite, no prefix). Because e5 stays bundled as the fallback (C2), a small e5 check is still legitimate — keep one minimal e5 test and label it as the fallback guard.

**Files:**
- Modify: `tests/core/embedding-model.node.test.ts`

- [ ] **Step 1: Retarget the cross-lingual tests to bundled granite (no prefix)**

Point the loader at the bundled granite dir under `public/models/granite` (the same artifact the extension ships) with `dtype:'q8'` and NO prefix, and keep the two cross-lingual assertions (English query closest to the matching English passage; Korean query closest to the matching English passage) plus the 384-dim check. This makes the node test guard the REAL production primary on a real runtime (onnxruntime-node), mirroring the eval default.

```typescript
// Scenario: the bundled PRIMARY (granite) must place a Korean/English query closer to the
// matching English passage than to an unrelated one - with NO e5-style prefix. If this fails,
// cross-lingual search is broken on the model we actually ship.
// Coverage: integration (real granite inference from the bundled artifact, no mock).
```

(Load via the local bundled path, e.g. point `env.localModelPath` at `public/models/` and load `'granite'` with `{ dtype: 'q8' }`, or load the dir directly — match however other node-side bundled-model loads in this repo resolve `public/models/`. Embeds use raw text: `embed('what hormone wrecks my sleep')`, `embed('cortisol disrupts REM sleep')`, etc. Korean: `embed('잠을 망치는 호르몬')`. The non-ASCII Korean is intentional and already allowed in this file by its existing comment.)

- [ ] **Step 2: Keep ONE minimal e5 fallback sanity check**

Retain a single small test that loads `Xenova/multilingual-e5-small` (WITH `query:`/`passage:` prefixes) and asserts it still produces 384-dim vectors and ranks the matching passage above the unrelated one — labeled as the FALLBACK guard, so the model the embedder falls back to is not silently rotted.

- [ ] **Step 3: Run the node test**

Run: `npx vitest run tests/core/embedding-model.node.test.ts`
Expected: PASS — granite cross-lingual guard holds on the bundled artifact; the e5 fallback check still passes.

- [ ] **Step 4: Commit**

```bash
git add tests/core/embedding-model.node.test.ts
git commit -m "test(core): retarget cross-lingual node guard to bundled granite; keep e5 fallback check"
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

Run: `npm run build`
Verify: `ls dist-ext/models/granite/onnx/model_quantized.onnx` (public copied verbatim) AND `ls dist-ext/models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx` (e5 fallback still bundled).

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

- [ ] **Step 2: Confirm no probe / stray-prefix residue (now scoped to `tests` too — I4)**

Run:
```bash
rg -n "granite-probe|__graniteProbe|model_qint8_arm64" src scripts eval tests
rg -n "query: |passage: " src scripts eval tests
```
Expected: NO probe/community-file references anywhere. The `query: `/`passage: ` prefixes survive ONLY in the e5 fallback paths (the embedder's e5 branch, the retained e5 fallback test, and the eval's `e5` prefix branch kept for A/B reproducibility) — confirm each hit is an e5-fallback site, not a leak into the granite path. (Note: unlike v1, we do NOT grep out `multilingual-e5-small` — e5 is a SHIPPED fallback now, so its presence in fetch-model, the embedder fallback, and the fallback test is correct.)

- [ ] **Step 3: Commit the plan document**

```bash
git add docs/superpowers/plans/2026-06-30-granite-model-swap.md
git commit -m "docs(plan): granite swap plan v2 - probe-our-artifact gate, e5 fallback, gradual reindex (adversarial-review fixes)"
```

---

## Self-Review

**1. Spec coverage**
- Bundle granite SAFE artifact (re-quantize IBM official) + fetch-model + build copy + KEEP e5 fallback + remove probe -> Tasks 5, 6, 9 (probe), 14 Step 2 (build copy).
- Probe OUR artifact under the production invocation BEFORE the swap, gating it (C1) -> Task 7; eval admits first self-quant measurement -> Task 12.
- Embedder swap (granite primary, e5 fallback, record loaded model, no prefix for granite / prefix for e5, WebGPU-primary/WASM-fallback + degraded signal, cache off) -> Task 8.
- Per-device-consistent version (keyed on loaded model) + gradual re-index (per-page clear, re-embed in place, drain re-embeds, write version after all pages; TDD pure pieces) -> Tasks 1, 2, 3 (pure, RED-first), 4 (worker), 9 (wire after load).
- Re-index UX: gradual not dark + real "N of M" denominator + degraded notice -> Task 3 (page-by-page), Task 9 (emit total + degraded rpc-event), Task 10 (relay both through the SW). UI consume is an explicit one-line follow-up.
- Cosine-floor audit (incl. recall-service.ts, cosine.ts) -> Task 11.
- e5 node test retargeted to granite + e5 fallback check; residue grep extended to `tests` -> Tasks 13, 15.
- Public/permanent host for the artifact -> Task 6. tokenizer.json assertion -> Task 5.
- File Map, Self-Review, Tradeoffs -> present.

**2. Placeholder scan**
- The only fill-ins are `<FIRST_PARTY_PUBLIC_BASE>` and the four granite `EXPECTED_HASHES` in Task 6, plus the IBM `REVISION` SHA in Task 5. These are generated artifacts (run `scripts/quantize-granite.py`, publish, paste the printed digests) — the same pattern as a lockfile hash, not lazy placeholders. Every other step has complete code/commands.

**3. Type consistency**
- `clearVectorsForPage(pageId: string): Promise<void>` — same name on `VectorSearchPort` (Task 2), `MemoryVectorStore` (Task 2), `WorkerVectorStore` (Task 4), worker op (Task 4), and `migrateEmbeddingModel`'s `Pick<...,'clearVectorsForPage'|'recentPages'>` (Task 3). Consistent.
- `getEmbedVersion()`/`setEmbedVersion(version)` — same on `SettingsPort` (Task 4), `WorkerSettingsStore` (Task 4), worker ops (Task 4), and `EmbedVersionStore` (Task 3). `WorkerSettingsStore` structurally satisfies `EmbedVersionStore`, so Task 9 passes `settings` directly. Consistent.
- `EMBED_VERSION_GRANITE`/`EMBED_VERSION_E5`/`versionForModel`/`needsReindex` — defined Task 1; imported by Task 3 (`embed-migration`) and Task 9 (`offscreen`). `embedder.model: 'granite'|'e5'|null` (Task 8) feeds `versionForModel` (Task 9). Consistent.
- `MODEL` ids: `GRANITE.id='granite'` matches `public/models/granite` (Task 6) + eval `BUNDLED='granite'` (Task 12) + node test (Task 13); `E5.id='Xenova/multilingual-e5-small'` matches the kept e5 dir (Task 6). Consistent.
- Re-index progress: offscreen emits `indexing-progress` with `total` (Task 9); SW relays `total` via `broadcastIndexingProgress(pending, embedded, total?)` (Task 10). Consistent; additive (panel ignores unknown fields until the follow-up).

No gaps found.

---

## Tradeoffs

- **Keeping e5 as a fallback (reverses v1's "replace e5").** v1 deleted e5 to save ~113MB. But with no fallback, a granite load failure on a device made the product PERMANENTLY unsearchable — capture would keep storing NULL-vector chunks that never become findable. v2 keeps e5 bundled (~113MB extra) so the embedder can always load SOMETHING. The owner accepts the size cost for the no-dead-fallback guarantee. The granite+e5 vectors are incompatible, so the fallback is CONSISTENT-PER-DEVICE: the embedder records which model actually loaded, the persisted version is keyed on it, and the whole corpus is embedded with that one model — never a mix. **Alternative considered:** drop e5 and instead show an explicit user-visible "embedder unavailable" state. Rejected as the default because "search just works (slower)" beats "search is off" for the user; the explicit-unavailable state is a reasonable future option if bundle size becomes critical.
- **Probe-our-artifact gate adds a manual step (C1).** The swap now blocks on a human running `__graniteProbe()` against OUR `model_quantized.onnx` on both WebGPU and forced-WASM. This is unavoidable: onnxruntime-web's WASM/WebGPU EPs may not support our optimum-avx2 q8 op-encoding, and only the real browser runtime can prove it (Node CPU int8 is a different runtime). The cost is one manual gate; the benefit is not shipping an artifact that silently fails to load for users.
- **Gradual re-index is mixed-model during the window (M1).** While the migration walks the corpus page by page, already-migrated pages hold new-model vectors and not-yet-migrated pages still hold old-model ones; a query (embedded with the new model) scores the old-model pages as noise. This window is bounded (it shrinks as the drain proceeds, and the query lane is prioritized so it finishes fast) and self-heals once every page is migrated. We ACCEPT and DOCUMENT this rather than hard-gating `recall` during the migration, because gating would re-introduce the very "search is dark" failure I1 set out to kill — the whole point of going page-by-page is that already-done pages serve good results immediately. If the cross-model noise proves bad in practice, the minimal mitigation is to gate `recall` to return an "updating" state until the migration's `setEmbedVersion` lands; noted for a later contributor.
- **Re-index time on large corpora (I1c budget).** The migration re-embeds every chunk, page by page. Search stays mostly alive (only the in-flight page is briefly pending), but the TOTAL wall-time on a big profile is unmeasured: the A/B validated quality at ~tens of documents (27 fixtures, ~5-16 queries/combo), not re-index time at scale, and WASM-only devices are much slower. The drain is incremental + resumable, the query lane is prioritized, and the IndexingIndicator now shows a real "N of M" bar, so the UI never looks broken — but a large corpus on WASM can still take many minutes. A wider golden set run before/after is the way to extend confidence past this budget.
- **WebGPU vs WASM, and granite vs e5, performance (I2).** Granite on WebGPU is the ideal. A device without WebGPU falls to WASM single-thread; a device where granite cannot be created falls to e5. Both are slower/weaker, and v2 surfaces them as an `embedder-degraded` event to the side panel (consumed by a one-line UI follow-up) instead of a buried console.warn, so the user understands why indexing/search is slow. A device that loads granite only intermittently could thrash (re-index on each model flip) — rare, since model load is deterministic per hardware/Chrome build; noted.
- **Granite's high cosine floor.** Unrelated pairs sit at ~0.56-0.65 cosine. Ranking is unaffected because it is relative (Task 11 audit), but any future feature wanting an ABSOLUTE "is this relevant at all?" gate (e.g. "no results" detection) must NOT reuse an e5-era cosine constant — it needs its own granite-calibrated threshold. Documented so a later contributor is not bitten.

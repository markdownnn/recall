# Granite Embedding Model Swap + Full Re-Index Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bundled embedding model `Xenova/multilingual-e5-small` with a first-party re-quantized `granite-embedding-107m-multilingual` (R1) and re-embed every stored chunk via a version-triggered migration, so Korean<->English cross-lingual search works without breaking the majority EN->EN case.

**Architecture:** Granite is the same 384-dim space as e5, so the vector store schema and ranking are unchanged. The swap is: (1) bundle a SAFE first-party granite ONNX (we re-quantize IBM's official fp32 ONNX ourselves, never the community quant), (2) point the embedder at it and drop the e5-only `query:`/`passage:` prefixes, (3) persist an embedding-model **version** in settings and, when it changes, NULL out every stored vector so the existing pending-chunk drain re-embeds the whole corpus with granite. The re-index reuses the existing `runDrainWithProgress()` broadcast, so the side panel's existing IndexingIndicator shows the "updating" state with no UI code change.

**Tech Stack:** TypeScript, Preact, `@huggingface/transformers` (transformers.js, WebGPU primary / WASM fallback), SQLite-WASM over OPFS in a worker, Vitest (unit), Playwright (e2e), Vite + CRXJS (build), Python `optimum`/`onnxruntime` (offline re-quantize recipe).

---

## Background the engineer needs

Read these before starting. They are the load-bearing facts.

- **Why granite, why R1, why a full re-index:** `docs/embedding-ab-results.md`. R1 is the only candidate with no broken language combo (keeps EN->KO alive), best overall MRR, 384-dim (no schema change), and already proven on the real-extension WebGPU path (probe: `device=webgpu dims=384 cos(bacteria, 박테리아)=0.698`). R2 and EmbeddingGemma collapse EN->KO to P@1 0.00 and are rejected.
- **The embedder:** `src/offscreen/webgpu-embedder.ts`. It runs the model in the offscreen document, WebGPU first and WASM single-thread as fallback, with a two-lane (query=high priority / passage=low priority) single-flight scheduler. e5 needs `query: ` / `passage: ` prefixes; **granite uses none** (raw `input_ids` + `attention_mask`).
- **How weights are bundled:** `scripts/fetch-model.mjs` downloads 4 files from a pinned HuggingFace commit into `public/models/.../` and hash-verifies each one (deletes + fails the build on mismatch). `public/models/` is gitignored (`.gitignore:12`). Vite copies `public/` verbatim into the build `outDir` (`dist-ext` for `npm run build`), so `public/models/...` becomes `dist-ext/models/...`.
- **The drain (re-index engine):** `src/core/indexing-service.ts`. `drain()` loops `store.pendingChunks(batch)` (chunks whose `vector IS NULL`) and embeds them. **Setting a chunk's vector back to NULL re-queues it for the drain.** That is the whole migration mechanism.
- **Storage:** `src/offscreen/sqlite-worker.ts` (`chunks` table with a `vector BLOB NULL` column; `settings` key/value table), surfaced through `src/offscreen/worker-vector-store.ts` and `src/offscreen/worker-settings-store.ts` over `src/offscreen/sqlite-worker-client.ts`. The in-memory twin used in tests and the eval is `src/adapters/memory-vector-store.ts`; the two engines are kept byte-for-byte equivalent (ADR 0020).
- **Ranking is relative, not cosine-thresholded:** `src/core/rrf.ts` (rank-based fusion), `src/core/ranking.ts` (`topPagesBySnippet` ranks by relative score; `chooseSnippetChunk` compares to `maxCos - epsilon`, a RELATIVE delta; `SNIPPET_TAU` is a prose-text threshold, not cosine), `src/core/cosine.ts`. Granite's unrelated-pair cosine floor is high (~0.56-0.65), so any ABSOLUTE cosine cutoff would break — Task 10 audits that none exists.
- **The throwaway probe to delete:** `src/offscreen/offscreen.ts` has a `granite-probe` RPC op, a `runGraniteProbe()` function, and a `__graniteProbe` global. These were the spike's feasibility proof and must be removed.
- **Parallel work — do not touch:** another task owns `src/ui/*`, `src/background/index.ts`, and `manifest.config.ts`. This plan deliberately reuses the EXISTING `indexing-progress` / `indexing-complete` broadcast (offscreen -> SW -> panel) so it needs no edits there.

---

## File Map

**Create:**
- `src/core/embed-version.ts` — pure: the `EMBED_MODEL_VERSION` constant + `needsReindex()` decision.
- `src/core/embed-migration.ts` — pure orchestration: `migrateEmbeddingModel(store, versions, current)` (clear vectors -> record version when version changed).
- `tests/core/embed-version.test.ts` — unit tests for `needsReindex` + the version constant.
- `tests/core/embed-migration.test.ts` — integration tests over the REAL `MemoryVectorStore` + a fake version store.
- `scripts/quantize-granite.py` — the SAFE re-quantize recipe (IBM official fp32 ONNX -> first-party `model_quantized.onnx`), pinned + hash-printing.
- `tests/e2e/granite-reindex.spec.ts` — e2e: granite loads + retrieves on the real extension path, and a relaunch does NOT re-index a matching version.

**Modify:**
- `src/offscreen/webgpu-embedder.ts` — model id, drop `query:`/`passage:` prefixes, `env.useBrowserCache=false`, degraded-WASM log.
- `tests/core/webgpu-embedder.test.ts` — update the prefix/batch/priority assertions to raw text.
- `src/core/ports.ts` — add `clearAllVectors()` to `VectorSearchPort`; add `getEmbedVersion()`/`setEmbedVersion()` to `SettingsPort`.
- `src/adapters/memory-vector-store.ts` — implement `clearAllVectors()`.
- `tests/core/memory-vector-store.test.ts` — test `clearAllVectors()`.
- `src/offscreen/sqlite-worker.ts` — `clearAllVectors`, `getEmbedVersion`, `setEmbedVersion` ops + handlers.
- `src/offscreen/worker-vector-store.ts` — `clearAllVectors()` passthrough.
- `src/offscreen/worker-settings-store.ts` — `getEmbedVersion()`/`setEmbedVersion()` passthrough.
- `src/offscreen/offscreen.ts` — remove the probe; run `migrateEmbeddingModel(...)` on init before the drain.
- `scripts/fetch-model.mjs` — fetch the first-party granite artifact set instead of e5.
- `eval/lib/embed-node.mjs` — default the eval to granite (bundled id + `none` prefix).

---

### Task 1: Pure version constant + re-index decision

**Files:**
- Create: `src/core/embed-version.ts`
- Test: `tests/core/embed-version.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/embed-version.test.ts
import { needsReindex, EMBED_MODEL_VERSION } from '../../src/core/embed-version'

// Scenario: after the e5 -> granite swap ships, a profile that last embedded with a
// different (or no) model id must trigger a full re-index; a profile already on granite
// must not.
// Coverage: integration (the real pure decision function).
test('needsReindex is true for a null or different stored version, false when equal', () => {
  expect(needsReindex(null, 'granite-107m-r1-q8-v1')).toBe(true)
  expect(needsReindex('e5-small-q8', 'granite-107m-r1-q8-v1')).toBe(true)
  expect(needsReindex('granite-107m-r1-q8-v1', 'granite-107m-r1-q8-v1')).toBe(false)
})

// Scenario: the version string is the single source of truth shared by the embedder,
// the migration, and the eval default. A typo here silently disables the migration.
// Coverage: integration (locks the literal value).
test('EMBED_MODEL_VERSION is the granite r1 q8 identifier', () => {
  expect(EMBED_MODEL_VERSION).toBe('granite-107m-r1-q8-v1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/embed-version.test.ts`
Expected: FAIL — cannot resolve `../../src/core/embed-version`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/embed-version.ts
// The bundled embedding model's identity, persisted per-profile so a model swap can
// trigger a full re-index. Bump the trailing -vN whenever the SHIPPED weights change in a
// way that makes old vectors incomparable (new model, new dtype, new dims): the offscreen
// migration compares this to the stored value and re-embeds the whole corpus on a mismatch.
export const EMBED_MODEL_VERSION = 'granite-107m-r1-q8-v1'

// True when the stored version is missing or differs from the current one, i.e. a re-index
// is required. Pure: the offscreen wires the real settings + store around this decision.
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
git commit -m "feat(core): embedding-model version constant + needsReindex decision"
```

---

### Task 2: `clearAllVectors` on the port + in-memory store

**Files:**
- Modify: `src/core/ports.ts`
- Modify: `src/adapters/memory-vector-store.ts`
- Test: `tests/core/memory-vector-store.test.ts`

- [ ] **Step 1: Add the method to the port (compile-time RED)**

In `src/core/ports.ts`, inside `interface VectorSearchPort`, add after the `setVector` line:

```typescript
  // Reset EVERY chunk's vector to pending (NULL). Used by the model-swap migration: after
  // this, pendingChunks() returns the whole corpus and the drain re-embeds it with the new
  // model. Pages and chunk text are untouched.
  clearAllVectors(): Promise<void>
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/core/memory-vector-store.test.ts  (append)
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { CapturedPage, Chunk } from '../../src/core/model'

// Scenario: an embedding-model swap must re-embed every stored chunk. clearAllVectors makes
// all embedded chunks pending again and removes them from search until re-embedded.
// Coverage: integration (real MemoryVectorStore - the VectorSearchPort contract).
test('clearAllVectors re-queues every embedded chunk and empties search', async () => {
  const store = new MemoryVectorStore()
  const page: CapturedPage = { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 }
  const a: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'cortisol and sleep' }
  const b: Chunk = { id: 'p1#1', pageId: 'p1', index: 1, text: 'tax accounting basics' }
  await store.upsertPage(page)
  await store.putChunks('p1', [a, b])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  await store.setVector('p1#1', new Float32Array([0, 1]))

  expect((await store.pendingChunks(100)).length).toBe(0)
  expect((await store.search(new Float32Array([1, 0]), '', 10)).length).toBeGreaterThan(0)

  await store.clearAllVectors()

  expect((await store.pendingChunks(100)).length).toBe(2)
  expect((await store.search(new Float32Array([1, 0]), '', 10)).length).toBe(0)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/core/memory-vector-store.test.ts -t clearAllVectors`
Expected: FAIL — `store.clearAllVectors is not a function` (and a type error on the port).

- [ ] **Step 4: Implement in the in-memory store**

In `src/adapters/memory-vector-store.ts`, add after `setVector`:

```typescript
  async clearAllVectors(): Promise<void> {
    for (const entry of this.chunks.values()) entry.vector = null
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/memory-vector-store.test.ts -t clearAllVectors`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/ports.ts src/adapters/memory-vector-store.ts tests/core/memory-vector-store.test.ts
git commit -m "feat(core): clearAllVectors on VectorSearchPort + memory store"
```

---

### Task 3: Pure migration orchestration

**Files:**
- Create: `src/core/embed-migration.ts`
- Test: `tests/core/embed-migration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/embed-migration.test.ts
import { migrateEmbeddingModel, type EmbedVersionStore } from '../../src/core/embed-migration'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { CapturedPage, Chunk } from '../../src/core/model'

function fakeVersions(initial: string | null): EmbedVersionStore & { value: string | null } {
  const state = { value: initial }
  return {
    value: state.value,
    async getEmbedVersion() {
      return state.value
    },
    async setEmbedVersion(v: string) {
      state.value = v
    },
  } as EmbedVersionStore & { value: string | null }
}

async function seededStore(): Promise<MemoryVectorStore> {
  const store = new MemoryVectorStore()
  const page: CapturedPage = { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 }
  const a: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'alpha' }
  await store.upsertPage(page)
  await store.putChunks('p1', [a])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  return store
}

// Scenario: the e5 -> granite swap ships; a profile that last embedded with e5 must have
// every vector cleared so the drain re-embeds with granite, and the new version recorded.
// Coverage: integration (real MemoryVectorStore + fake version store).
test('stale version triggers a clear + records the new version', async () => {
  const store = await seededStore()
  const versions = fakeVersions('e5-small-q8')

  const reindexed = await migrateEmbeddingModel(store, versions, 'granite-107m-r1-q8-v1')

  expect(reindexed).toBe(true)
  expect((await store.pendingChunks(100)).length).toBe(1) // vector cleared -> pending
  expect(await versions.getEmbedVersion()).toBe('granite-107m-r1-q8-v1')
})

// Scenario: a profile already on granite reopens the extension. The migration must be a
// no-op: it must NOT wipe durable vectors and force a needless full re-embed every launch.
// Coverage: integration (real MemoryVectorStore + fake version store).
test('matching version is a no-op (vectors preserved, no rewrite)', async () => {
  const store = await seededStore()
  const versions = fakeVersions('granite-107m-r1-q8-v1')

  const reindexed = await migrateEmbeddingModel(store, versions, 'granite-107m-r1-q8-v1')

  expect(reindexed).toBe(false)
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

// If the stored embedding-model version differs from `current`, clear ALL chunk vectors so
// the drain re-embeds the whole corpus with the new model, then record `current`. Returns
// true when a re-index was triggered. Order matters: clear succeeds BEFORE the version is
// recorded, so an interrupted run leaves chunks pending (the drain finishes them later) and
// the version unchanged (the next launch retries the clear, which is idempotent).
export async function migrateEmbeddingModel(
  store: Pick<VectorSearchPort, 'clearAllVectors'>,
  versions: EmbedVersionStore,
  current: string,
): Promise<boolean> {
  const stored = await versions.getEmbedVersion()
  if (!needsReindex(stored, current)) return false
  await store.clearAllVectors()
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
git commit -m "feat(core): migrateEmbeddingModel orchestration (version -> clearAllVectors)"
```

---

### Task 4: Persist the version + clear-all in the sqlite worker

**Files:**
- Modify: `src/core/ports.ts`
- Modify: `src/offscreen/sqlite-worker.ts`
- Modify: `src/offscreen/worker-vector-store.ts`
- Modify: `src/offscreen/worker-settings-store.ts`

> This task wires the OPFS-backed implementations of the contracts added in Tasks 2-3. The worker runs only inside the extension (real OPFS), so it has no Vitest unit; it is exercised by the Task 12 e2e. The pure contracts it satisfies are already proven by Tasks 2-3.

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
function opClearAllVectors(db: any): void {
  // Re-queue every chunk for the drain by nulling its vector. Page/chunk text untouched.
  db.exec({ sql: `UPDATE chunks SET vector = NULL` })
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
  clearAllVectors: (db) => { opClearAllVectors(db) },
  getEmbedVersion: (db) => opGetEmbedVersion(db),
  setEmbedVersion: (db, args) => { opSetEmbedVersion(db, args as string) },
```

- [ ] **Step 4: Add the vector-store passthrough**

In `src/offscreen/worker-vector-store.ts`, add after the `setVector` line:

```typescript
  clearAllVectors = () => this.c.request<void>('clearAllVectors')
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
git commit -m "feat(offscreen): persist embed-model version + clearAllVectors worker op"
```

---

### Task 5: Swap the embedder to granite (model id, no prefixes, cache off)

**Files:**
- Modify: `src/offscreen/webgpu-embedder.ts`
- Test: `tests/core/webgpu-embedder.test.ts`

- [ ] **Step 1: Update the prefix/priority/batch tests to raw text (RED)**

In `tests/core/webgpu-embedder.test.ts`:

Replace the `kind prefix` test body and rename it:

```typescript
// Scenario: granite takes raw input_ids+attention_mask and must NOT receive e5's
// "query: "/"passage: " prefixes; leaking them poisons every embedding.
// Coverage: integration (fake records the exact strings the model receives).
test('no prefix: raw text reaches the model for both lanes', async () => {
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

In the `priority` test, change the final assertion to raw text:

```typescript
  expect(fake.calls.flat()).toEqual(['p1', 'q1', 'p2'])
```

In the `batching` test, change the `batchSizes` line (the warmup call is the literal `warmup`, all others are passages here):

```typescript
  const batchSizes = fake.calls.filter((c) => c[0] !== 'warmup').map((c) => c.length)
```

- [ ] **Step 2: Run the embedder tests to verify they fail**

Run: `npx vitest run tests/core/webgpu-embedder.test.ts`
Expected: FAIL — `flat` still contains `query: foo`; priority order is `['passage: p1', ...]`; the implementation still prefixes.

- [ ] **Step 3: Implement the embedder swap**

In `src/offscreen/webgpu-embedder.ts`:

(a) Change the model id constant:

```typescript
// Granite is loaded by the bare directory name 'granite' from env.localModelPath
// (public/models/granite/, fetched at build time by scripts/fetch-model.mjs). dtype:'q8'
// requests onnx/model_quantized.onnx - our FIRST-PARTY re-quantized artifact (Task 6/7),
// never the community quant. Same 384-dim space as the old e5 model, so storage is unchanged.
const MODEL_ID = 'granite'
```

(b) In `configureEnv()`, after the `env.allowRemoteModels = false` line, disable the browser cache:

```typescript
    // We bundle the model locally, so transformers.js's browser cache is pointless and, in
    // a chrome-extension context, warns "Cache 'put' ... unsupported". Turn it off.
    env.useBrowserCache = false
```

(c) In `createPipe()`, change BOTH warmup calls from `['query: warmup']` to `['warmup']` (granite has no prefix):

```typescript
      await pipe(['warmup'], { pooling: 'mean', normalize: true })
```

(d) In `createPipe()`, in the WASM-fallback branch, make the degraded state loud. Replace the `console.log('[recall] embedder ready on WASM (single-thread)')` line with:

```typescript
    console.warn(
      '[recall] DEGRADED: embedder fell back to WASM single-thread (no WebGPU here); ' +
        'indexing and search will be noticeably slower',
    )
```

(e) In `runEmbed()`, stop prefixing — embed the raw slice. Replace:

```typescript
        const slice = texts.slice(i, i + BATCH)
        const prefixed = slice.map((t) => `${kind}: ${t}`)
```

with:

```typescript
        // Granite takes raw text in both lanes (no e5 "query:"/"passage:" prefix). The `kind`
        // still drives the two-lane scheduler priority; it just no longer alters the text.
        const slice = texts.slice(i, i + BATCH)
```

and replace the two later uses of `prefixed` with `slice`:

```typescript
        const output = await pipe(slice, { pooling: 'mean', normalize: true })
        console.log(`[Recall:perf] embed batch=${slice.length} ${Math.round(performance.now() - b0)}ms`)
```

- [ ] **Step 4: Run the embedder tests to verify they pass**

Run: `npx vitest run tests/core/webgpu-embedder.test.ts`
Expected: PASS — raw text reaches the model; priority order `['p1','q1','p2']`; batches `[8,8,4]`.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/webgpu-embedder.ts tests/core/webgpu-embedder.test.ts
git commit -m "feat(offscreen): point embedder at granite, drop e5 prefixes, cache off, WASM-degraded log"
```

---

### Task 6: Safe first-party re-quantize recipe

**Files:**
- Create: `scripts/quantize-granite.py`

> **Why this exists.** The spike loaded `gety-ai/...`'s community int8 binary. We must NOT bundle an unaudited third-party quant in a privacy extension. Instead we re-quantize IBM's OFFICIAL fp32 ONNX ourselves into a standard-named `onnx/model_quantized.onnx` that transformers.js loads with the normal `dtype:'q8'`. (The A/B noted `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` ships a clean standard quant, but that is R2 — rejected for collapsing EN->KO — so we cannot just grab a clean R2 build.) This script is run once by a maintainer / in CI; its outputs are published to a first-party location and Task 7 fetches + hash-verifies them. It is not part of `npm run build`.

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
AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION).save_pretrained(OUT)

# 2. Dynamic int8 quantization (avx2 dynamic = CPU-portable int8, the q8 transformers.js loads).
quantizer = ORTQuantizer.from_pretrained(OUT, file_name="model.onnx")
qconfig = AutoQuantizationConfig.avx2(is_static=False, per_channel=False)
quantizer.quantize(save_dir=OUT, quantization_config=qconfig)

# 3. Normalize the quantized file name to the transformers.js convention.
produced = os.path.join(OUT, "model_quantized.onnx")
target = os.path.join(ONNX_DIR, "model_quantized.onnx")
if os.path.exists(produced):
    os.replace(produced, target)

# 4. Print SHA-256 of every file Task 7 bundles, to paste into EXPECTED_HASHES.
for rel in ["config.json", "tokenizer_config.json", "tokenizer.json", "onnx/model_quantized.onnx"]:
    path = os.path.join(OUT, rel)
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    size_mb = os.path.getsize(path) / 1e6
    print(f"{rel:34s} {digest}  ({size_mb:.1f} MB)")
```

- [ ] **Step 2: Document the publish + pin step (no code; a comment block at the top of `scripts/fetch-model.mjs` in Task 7 references this)**

The maintainer runs the script, uploads the four files under `dist-model/granite/` to the first-party model host (a private/org HuggingFace repo such as `liner/granite-embedding-107m-multilingual-recall`, or a tagged GitHub release asset), records the printed SHA-256 values, and replaces `REVISION = "main"` with the exact IBM commit SHA used, so the build is reproducible.

- [ ] **Step 3: Commit**

```bash
git add scripts/quantize-granite.py
git commit -m "build: first-party granite re-quantize recipe (IBM official fp32 -> int8)"
```

---

### Task 7: Fetch the granite artifact at build time

**Files:**
- Modify: `scripts/fetch-model.mjs`

> `npm run prebuild` runs this before every build. It must download our FIRST-PARTY granite artifact (Task 6) and hash-verify each file, exactly like the existing e5 flow.

- [ ] **Step 1: Replace the model coordinates**

In `scripts/fetch-model.mjs`, replace the `SHA` / `HF_BASE` / `MODEL_DIR` block:

```javascript
// First-party granite artifact (re-quantized from IBM official fp32 by scripts/quantize-granite.py,
// then published to our pinned host). NOT the community quant. Replace <FIRST_PARTY_BASE> with the
// pinned resolve URL of the published artifact (e.g. an org HF repo at a fixed commit SHA, or a
// tagged GitHub release asset base).
const HF_BASE = '<FIRST_PARTY_BASE>'
const MODEL_DIR = resolve(ROOT, 'public/models/granite')
```

(Remove the now-unused `SHA` constant.)

- [ ] **Step 2: Replace the expected hashes with the printed digests**

Paste the four SHA-256 values printed by `python scripts/quantize-granite.py` (Task 6) into `EXPECTED_HASHES`:

```javascript
const EXPECTED_HASHES = {
  'config.json':               '<sha256 from quantize-granite.py>',
  'tokenizer_config.json':     '<sha256 from quantize-granite.py>',
  'tokenizer.json':            '<sha256 from quantize-granite.py>',
  'onnx/model_quantized.onnx': '<sha256 from quantize-granite.py>',
}
```

- [ ] **Step 3: Replace the file list**

```javascript
const FILES = [
  { rel: 'config.json',               url: `${HF_BASE}/config.json` },
  { rel: 'tokenizer_config.json',     url: `${HF_BASE}/tokenizer_config.json` },
  { rel: 'tokenizer.json',            url: `${HF_BASE}/tokenizer.json` },
  { rel: 'onnx/model_quantized.onnx', url: `${HF_BASE}/onnx/model_quantized.onnx` },
]
```

- [ ] **Step 4: Remove the stale e5 model directory**

Granite REPLACES e5 (it is smaller, ~102-118 MB; keeping both wastes bundle size). Delete the old bundled dir so a stale e5 model can't ship:

```bash
rm -rf public/models/Xenova
```

- [ ] **Step 5: Run the fetcher**

Run: `npm run eval:fetch-model`
Expected: `[fetch-model] done onnx/model_quantized.onnx (~102 MB, hash ok)` for all four files, ending with `All model files present and verified.` (A wrong/tampered file is deleted and the script exits 1.)

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-model.mjs
git commit -m "build: fetch first-party granite artifact, drop bundled e5"
```

---

### Task 8: Run the migration on offscreen init + remove the probe

**Files:**
- Modify: `src/offscreen/offscreen.ts`

- [ ] **Step 1: Import the migration pieces**

In `src/offscreen/offscreen.ts`, add to the imports near the other `../core/...` imports:

```typescript
import { migrateEmbeddingModel } from '../core/embed-migration'
import { EMBED_MODEL_VERSION } from '../core/embed-version'
```

- [ ] **Step 2: Replace the on-load drain with migrate-then-drain**

Replace the on-load call (the single `runDrainWithProgress()` under the "On load: resume any pending chunks" comment) with:

```typescript
// On load: if the bundled embedding model changed since this profile was last indexed,
// re-index. migrateEmbeddingModel nulls every stored vector when the version differs, so the
// drain below re-embeds the WHOLE corpus with granite; a matching version is a no-op. We
// always run the drain afterward to (a) finish a fresh re-index and (b) resume any chunks left
// pending by a previous interrupted session. The drain broadcasts indexing-progress, which the
// side panel already renders as the "updating search index" state - no UI change needed.
migrateEmbeddingModel(store, settings, EMBED_MODEL_VERSION)
  .catch((e) => console.error('[recall/offscreen] embed-model migration failed:', e))
  .finally(() => runDrainWithProgress())
```

- [ ] **Step 3: Remove the throwaway probe — RPC op**

Delete the entire `if (op === 'granite-probe')` block (the `[THROWAWAY:granite-probe]` comment through `return await runGraniteProbe()`).

- [ ] **Step 4: Remove the throwaway probe — function + global**

Delete the entire trailing `[THROWAWAY:granite-probe]` section: the `runGraniteProbe()` function and the `;(globalThis as any).__graniteProbe = runGraniteProbe` line.

- [ ] **Step 5: Verify the probe is gone**

Run: `rg -n "granite-probe|__graniteProbe|runGraniteProbe" src`
Expected: NO matches.

- [ ] **Step 6: Typecheck + unit suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/offscreen/offscreen.ts
git commit -m "feat(offscreen): re-index on embed-model version change; remove granite probe"
```

---

### Task 9: Cosine-floor audit (verification)

**Files:** none changed (audit only).

> Granite's unrelated-pair cosine sits high (~0.56-0.65). Ranking is preserved because it is RELATIVE (RRF rank-based, top-by-score, relative epsilon). Any ABSOLUTE cosine cutoff (e.g. `cos > 0.5` to drop "irrelevant" results) would silently break under granite. This task proves none exists.

- [ ] **Step 1: Grep for absolute cosine thresholds**

Run:
```bash
rg -n "cosine|\bcos\b|similarity|0\.[0-9]+|threshold|cutoff|score *[<>]=?" src/core src/adapters src/offscreen/sqlite-worker.ts src/offscreen/worker-vector-store.ts
```

- [ ] **Step 2: Confirm every cosine site is relative, not an absolute gate**

Verify against this checklist (the only cosine/score sites in the retrieval path):
- `src/core/rrf.ts` — fusion is `1/(k+rank)`, RANK-based. No cosine value compared to a constant. RELATIVE. OK.
- `src/core/ranking.ts` `topPagesBySnippet` — sorts by `score` desc and slices top-k. No absolute floor. RELATIVE. OK.
- `src/core/ranking.ts` `chooseSnippetChunk` — compares `c.cos >= maxCos - epsilon` (a delta from THIS query's max) and `proseScore(text) >= SNIPPET_TAU` (a TEXT score, not cosine). RELATIVE. OK.
- `src/core/ranking.ts` constants — `SNIPPET_EPSILON=0.03` is a relative delta; `SNIPPET_TAU=0.35` is a prose-text threshold; `LEXICAL_RRF_WEIGHT=2` is a rank weight; `CANDIDATE_PAGE_LIMIT=50` is a count. None is an absolute cosine gate. OK.
- `src/adapters/memory-vector-store.ts` / `src/offscreen/sqlite-worker.ts` `search` — push ALL embedded chunks (only `vector === null` / `vector IS NULL` is skipped) into the rankers; no `cos > X` filter. RELATIVE. OK.

Expected: the grep surfaces ONLY the sites above, every one relative/non-cosine. If any NEW site compares a cosine value to an absolute constant to DROP a result, stop and report it — that is a real break under granite and must be removed before shipping.

- [ ] **Step 3: Record the audit result (commit message only; no file change)**

```bash
git commit --allow-empty -m "chore: cosine-floor audit - ranking is relative-only, safe for granite's high floor"
```

---

### Task 10: Default the eval to granite + re-validate

**Files:**
- Modify: `eval/lib/embed-node.mjs`

- [ ] **Step 1: Change the bundled-model defaults**

In `eval/lib/embed-node.mjs`, change the bundled id and the default prefix so a bare `npm run eval` measures the PRODUCTION (granite) model offline from `public/models/granite`:

```javascript
const BUNDLED = 'granite' // bundled prod model dir under public/models/ (granite-107m R1)
const MODEL = process.env.EVAL_MODEL || BUNDLED
const DTYPE = process.env.EVAL_DTYPE || 'q8'
const PREFIX = process.env.EVAL_PREFIX || 'none' // granite takes raw text (no e5 prefix)
```

(Granite ships a standard `onnx/model_quantized.onnx`, so no `EVAL_MODEL_FILE` is needed.)

- [ ] **Step 2: Ensure the bundled granite is present, then run the eval**

Run:
```bash
npm run eval:fetch-model
rm -rf eval/.cache/embeds
npm run eval -- --strip --min-prose=0.35
```

- [ ] **Step 3: Confirm the A/B numbers hold**

Expected (matches `docs/embedding-ab-results.md`, directional given n=5 per cross combo):
- No combo collapses to P@1 0.00 — in particular **EN->KO P@1 stays ~0.40** (R2/EmbeddingGemma fail here; R1 must not).
- KO->EN is non-zero (~P@1 0.40 / R@5 0.80), the e5 weak spot fixed.
- EN->EN is preserved (not regressed toward 0.14).
- Reference-snippet rate (`refRate`) is 0.

If any combo collapses, STOP — the bundled artifact does not match the spike's model; re-check Task 6/7 (wrong revision or quant), do not ship.

- [ ] **Step 4: Commit**

```bash
git add eval/lib/embed-node.mjs
git commit -m "eval: default to granite-107m R1 as the production model"
```

---

### Task 11: e2e — granite loads + retrieves; relaunch does not re-index a matching version

**Files:**
- Create: `tests/e2e/granite-reindex.spec.ts`

> The cross-VERSION upgrade (stale -> granite triggers clear + re-embed) is proven by the Task 3 integration test against the real store. This e2e covers the two real-runtime risks Vitest cannot: (a) our first-party granite artifact actually loads and retrieves through the real offscreen WebGPU/WASM path, and (b) a relaunch on a MATCHING version does NOT destructively re-index (a buggy migration that re-clears every launch would wipe durable vectors and is caught here).

- [ ] **Step 1: Write the e2e**

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

// Drive a recall query through the SW -> offscreen RPC and return the matched page ids.
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

// Seed a known page and wait until it is searchable (drain finished embedding it).
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
  // Reuses the PROFILE seeded by the previous test (granite already recorded as the version).
  const ctx = await launchCtx()
  try {
    const extId = await getExtId(ctx)
    // No re-capture, no long wait: if the migration wrongly re-cleared on launch, the page
    // would be pending (vector NULL) and this immediate query would return nothing.
    await expect
      .poll(async () => (await recall(ctx, extId, 'microbiology bacteria')).length, { timeout: 15000 })
      .toBeGreaterThan(0)
  } finally {
    await ctx.close()
  }
})
```

- [ ] **Step 2: Build the extension so the e2e loads granite**

Run: `npm run build`
Expected: `dist-ext/` produced; `dist-ext/models/granite/onnx/model_quantized.onnx` exists (public copied verbatim).

Verify: `ls dist-ext/models/granite/onnx/model_quantized.onnx`
Expected: the file is listed.

- [ ] **Step 3: Run the e2e**

Run: `npx playwright test tests/e2e/granite-reindex.spec.ts`
Expected: both tests PASS. (If the RPC `channel`/`op` envelope differs in this repo, align the `sendMessage` shape in the helpers with an existing passing spec such as `tests/e2e/hybrid-search.spec.ts` — reuse its exact recall-driving pattern.)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/granite-reindex.spec.ts
git commit -m "test(e2e): granite loads + retrieves; matching-version relaunch does not re-index"
```

---

### Task 12: Final verification + plan-doc commit

- [ ] **Step 1: Full unit suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all PASS.

- [ ] **Step 2: Confirm no e5 / probe / prefix residue**

Run:
```bash
rg -n "multilingual-e5-small|granite-probe|__graniteProbe|query: |passage: " src scripts eval
```
Expected: no production references to e5, the probe, or the e5 prefixes (eval `withPrefix` may still DEFINE the `e5` branch for A/B reproducibility, but the bundled default is `none`).

- [ ] **Step 3: Commit the plan document**

```bash
git add docs/superpowers/plans/2026-06-30-granite-model-swap.md
git commit -m "docs(plan): swap embedding model to granite-107m R1 (KO<->EN) + full re-index migration"
```

---

## Self-Review

**1. Spec coverage**
- Bundle granite safe artifact (re-quantize IBM official) + fetch-model + build copy + replace e5 + remove probe -> Tasks 6, 7, 8 (probe), 11 Step 2 (build copy).
- Embedder swap (model id, drop prefixes, WebGPU-primary/WASM-fallback + degraded log, cache off) -> Task 5.
- Model-version tracking + full re-index (version compare, clearAllVectors, drain re-embeds, write version; TDD pure pieces) -> Tasks 1, 2, 3 (pure, RED-first), 4 (worker), 8 (wire on init).
- Re-index UX (non-blocking "updating", reuse IndexingIndicator + indexing-progress) -> Task 8 Step 2 reuses `runDrainWithProgress()`; explicitly NO `src/ui` / `src/background` edits (parallel task owns them).
- Cosine-floor audit -> Task 9.
- Re-validate (eval default -> granite, numbers hold, refRate 0) -> Task 10.
- Fallback/failure (load failure -> existing pipe-reset/self-heal; old-Chrome/no-WebGPU -> WASM logged) -> Task 5 keeps the existing poisoned-pipe + dead-pipe self-heal (those tests stay green) and adds the degraded-WASM log; capture-stores-then-drains behavior is unchanged.
- File Map, Self-Review, Tradeoffs -> present.

**2. Placeholder scan**
- The only intentional fill-ins are `<FIRST_PARTY_BASE>` and the four `EXPECTED_HASHES` in Task 7, plus the IBM `REVISION` SHA in Task 6. These are NOT lazy placeholders: they are values produced by running `scripts/quantize-granite.py` (Task 6 Step 1) and publishing its outputs (Task 6 Step 2), then pasted in Task 7 Steps 2-3 — the same generated-artifact pattern as a lockfile hash. Every other step has complete code/commands.

**3. Type consistency**
- `clearAllVectors(): Promise<void>` — same name on `VectorSearchPort` (Task 2), `MemoryVectorStore` (Task 2), `WorkerVectorStore` (Task 4), worker op `clearAllVectors` (Task 4), and `migrateEmbeddingModel`'s `Pick<...,'clearAllVectors'>` (Task 3). Consistent.
- `getEmbedVersion()`/`setEmbedVersion(version)` — same on `SettingsPort` (Task 4), `WorkerSettingsStore` (Task 4), worker ops (Task 4), and `EmbedVersionStore` (Task 3). `WorkerSettingsStore` structurally satisfies `EmbedVersionStore`, so Task 8 passes `settings` directly. Consistent.
- `EMBED_MODEL_VERSION = 'granite-107m-r1-q8-v1'` and `needsReindex` — defined Task 1, imported by Task 3 (`embed-migration`) and Task 8 (`offscreen`). Consistent.
- `MODEL_ID = 'granite'` (Task 5) matches `public/models/granite` (Task 7) and `env.localModelPath = models/`, and the eval `BUNDLED = 'granite'` (Task 10). Consistent.

No gaps found.

---

## Tradeoffs

- **Re-index time on large corpora.** The migration NULLs every vector, so the first launch after the upgrade re-embeds the WHOLE corpus. Search is degraded (vector lane empty for not-yet-re-embedded pages) until the drain finishes — minutes for a big profile. Mitigations already in place: the drain is incremental and resumable (pending chunks survive restarts and are re-attempted on ping/keep-alive), the query lane is prioritized over passage re-embedding, and the existing IndexingIndicator shows the state so the UI never looks broken. We accept a one-time slow window over a blocking modal.
- **WebGPU vs WASM performance.** Granite is proven on WebGPU (the spike probe). On machines without WebGPU it silently falls back to WASM single-thread, which is much slower for both the migration re-embed and live search. We surface this with a `DEGRADED` warn (Task 5); turning it into an opt-in telemetry `model_loaded { device: 'wasm' }` event is a small follow-up using the existing `src/core/telemetry.ts` taxonomy.
- **Replacing e5 rather than keeping both.** Granite is the same 384-dim and SMALLER (~102-118 MB vs 113 MB), and shipping two models doubles bundle weight for no benefit, so we drop e5 entirely (`rm -rf public/models/Xenova`). Cost: no instant client-side rollback to e5 — reverting means shipping a build that re-pins e5, which itself triggers a re-index. Acceptable for a clean cutover.
- **Granite's high cosine floor.** Unrelated pairs sit at ~0.56-0.65 cosine. Ranking is unaffected because it is relative (Task 9 audit), but any future feature that wants an ABSOLUTE "is this relevant at all?" gate (e.g. "no results" detection) must NOT reuse an e5-era cosine constant — it needs its own granite-calibrated threshold. Documented so a later contributor does not get bitten.
- **Small per-combo n in the A/B.** The verdict rests on 5 queries per cross combo (one query = 0.20 P@1), so the numbers are directional, not precise. A wider, multi-domain golden set (the extended 35-query set already started in `docs/embedding-ab-results.md`) is a good follow-up to run BEFORE and AFTER this swap to confirm no regression with tighter confidence — but it is not a blocker for a model that already has no broken combo and is the only one proven on the real WebGPU path.

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-granite-model-swap.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

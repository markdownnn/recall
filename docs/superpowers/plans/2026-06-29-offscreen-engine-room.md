# Offscreen Engine Room: Storage + Core into Offscreen, SW as Thin Relay

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the OPFS sqlite store (via a dedicated worker) and all three core services (Capture, Indexing, Recall) into the offscreen document, turning the background service worker into a dumb message relay with no core logic.

**Architecture:** The offscreen document becomes the "engine room": it owns the sqlite worker (OPFS-persistent via SAH pool VFS), the WebGPU embedder, and the three core services. The SW receives messages from popup/content, forwards them to the offscreen as RPC calls, and re-broadcasts progress events back to the popup. No Float32Arrays cross `chrome.runtime` anymore because embedding and storage happen in the same process.

**Tech Stack:** TypeScript, Vite + CRXJS, `@sqlite.org/sqlite-wasm` (SAH pool OPFS VFS), `@huggingface/transformers` (WebGPU/WASM), Playwright for e2e, Vitest for unit tests.

---

## File Map

| File | Action | Responsibility after change |
|------|--------|-----------------------------|
| `src/offscreen/sqlite-worker.ts` | **Rewrite** | Full VectorSearchPort ops over OPFS DB (upsertPage, putChunks, pendingChunks, setVector, search) |
| `src/offscreen/offscreen-worker-store.ts` | **Create** | `OffscreenWorkerStore implements VectorSearchPort` — wraps the sqlite worker via request/reply promise map |
| `src/offscreen/offscreen.ts` | **Modify** | Add core services (Capture/Indexing/Recall), extend RPC handler with `capture`/`recall`/`ping` ops, remove old spike counter code |
| `src/background/index.ts` | **Modify** | Remove core services/store/embedder; become a thin relay that forwards capture/recall to offscreen via RPC and re-broadcasts progress events |
| `tests/e2e/persistence.spec.ts` | **Create** | e2e proof: captured data survives a full browser restart (Cortisol ranks first in a fresh context) |
| `tests/e2e/sqlite-vector-store.spec.ts` | **Delete** | Tests the old in-SW store path; now obsolete since real store lives in the worker |

**Files NOT touched:**
- `src/core/*` — pure domain logic, stays chrome-free
- `src/adapters/memory-vector-store.ts` — still used by unit tests
- `src/offscreen/offscreen-rpc.ts` — RPC infrastructure unchanged
- `src/offscreen/webgpu-embedder.ts` — unchanged
- All `tests/core/*.test.ts` — use MemoryVectorStore/fakes, unaffected

---

## Task 1: Rewrite sqlite-worker.ts — full VectorSearchPort over OPFS

This replaces the spike counter with the real database schema and all five port operations. The worker keeps the same OPFS SAH pool init the spike proved works, just with a different pool name and file, and with the proper schema and message format.

**Files:**
- Rewrite: `src/offscreen/sqlite-worker.ts`

- [ ] **Step 1: Rewrite sqlite-worker.ts**

Replace the entire file with:

```typescript
// Real sqlite worker: owns the OPFS SAH pool DB for the recall extension.
// Handles request messages { id, op, args } and replies { id, result } or { id, error }.
// Ops mirror VectorSearchPort: upsertPage, putChunks, pendingChunks, setVector, search.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { cosineSimilarity } from '../core/cosine'

import type { CapturedPage, Chunk, RankedResult } from '../core/model'

let db: any = null

const initPromise: Promise<void> = (async () => {
  try {
    const sqlite3 = await sqlite3InitModule()
    const poolUtil = await (sqlite3 as any).installOpfsSAHPoolVfs({ name: 'recall-pool' })
    db = new poolUtil.OpfsSAHPoolDb('/recall.sqlite3')
    db.exec({ sql: `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, url TEXT, title TEXT, capturedAt INTEGER)` })
    db.exec({ sql: `CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, pageId TEXT, idx INTEGER, text TEXT, vector BLOB NULL)` })
    console.log('[recall-worker] sqlite OPFS SAH pool ready, schema created')
  } catch (e) {
    console.error('[recall-worker] init FAILED:', String(e))
    throw new Error(String(e))
  }
})()

function opUpsertPage(page: CapturedPage): void {
  db.exec({
    sql: `INSERT OR REPLACE INTO pages (id, url, title, capturedAt) VALUES (?, ?, ?, ?)`,
    bind: [page.id, page.url, page.title, page.capturedAt],
  })
}

function opPutChunks(pageId: string, chunks: Chunk[]): void {
  db.exec({ sql: 'DELETE FROM chunks WHERE pageId = ?', bind: [pageId] })
  for (const chunk of chunks) {
    db.exec({
      sql: `INSERT INTO chunks (id, pageId, idx, text, vector) VALUES (?, ?, ?, ?, NULL)`,
      bind: [chunk.id, chunk.pageId, chunk.index, chunk.text],
    })
  }
}

function opPendingChunks(limit: number): Chunk[] {
  const result: Chunk[] = []
  db.exec({
    sql: `SELECT id, pageId, idx, text FROM chunks WHERE vector IS NULL LIMIT ?`,
    bind: [limit],
    rowMode: 'object',
    callback: (r: any) => result.push({ id: r.id, pageId: r.pageId, index: r.idx, text: r.text }),
  })
  return result
}

function opSetVector(chunkId: string, vectorF32: Float32Array): void {
  // vectorF32 arrives via structured clone — it is a real Float32Array.
  // Store the raw bytes as BLOB so we can reconstruct it on search.
  const bytes = new Uint8Array(vectorF32.buffer, vectorF32.byteOffset, vectorF32.byteLength)
  db.exec({
    sql: 'UPDATE chunks SET vector = ? WHERE id = ?',
    bind: [bytes, chunkId],
  })
}

function opSearch(queryF32: Float32Array, k: number): RankedResult[] {
  // Load all pages into a Map for O(1) lookup during chunk iteration.
  const pages = new Map<string, CapturedPage>()
  db.exec({
    sql: `SELECT id, url, title, capturedAt FROM pages`,
    rowMode: 'object',
    callback: (r: any) => pages.set(r.id, { id: r.id, url: r.url, title: r.title, capturedAt: r.capturedAt }),
  })

  const scored: RankedResult[] = []
  db.exec({
    sql: `SELECT id, pageId, idx, text, vector FROM chunks WHERE vector IS NOT NULL`,
    rowMode: 'object',
    callback: (r: any) => {
      const page = pages.get(r.pageId)
      if (!page) return
      // Safe blob -> Float32Array reconstruction (same pattern as SqliteVectorStore).
      const bytes = r.vector as Uint8Array
      const f32view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      // Copy to a standalone array so it outlives the callback frame.
      const vector = new Float32Array(f32view)
      const chunk: Chunk = { id: r.id, pageId: r.pageId, index: r.idx, text: r.text }
      scored.push({ chunk, page, score: cosineSimilarity(queryF32, vector) })
    },
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

;(self as DedicatedWorkerGlobalScope).onmessage = async (e: MessageEvent) => {
  const { id, op, args } = e.data as { id: number; op: string; args: any }
  try {
    await initPromise
    let result: unknown
    switch (op) {
      case 'upsertPage':
        opUpsertPage(args.page as CapturedPage)
        result = undefined
        break
      case 'putChunks':
        opPutChunks(args.pageId as string, args.chunks as Chunk[])
        result = undefined
        break
      case 'pendingChunks':
        result = opPendingChunks(args.limit as number)
        break
      case 'setVector':
        opSetVector(args.chunkId as string, args.vector as Float32Array)
        result = undefined
        break
      case 'search':
        result = opSearch(args.queryVector as Float32Array, args.k as number)
        break
      default:
        throw new Error(`[recall-worker] unknown op: ${op}`)
    }
    ;(self as DedicatedWorkerGlobalScope).postMessage({ id, result })
  } catch (err) {
    ;(self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) })
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
cd /Users/minhyeokkim/recall && npx tsc --noEmit
```

Expected: zero errors. If you see "cannot find module '../core/cosine'" the import path is wrong — the worker lives at `src/offscreen/sqlite-worker.ts` so `../core/cosine` resolves to `src/core/cosine.ts`.

- [ ] **Step 3: Commit**

```bash
cd /Users/minhyeokkim/recall
git add src/offscreen/sqlite-worker.ts
git commit -m "refactor: extend sqlite-worker to full VectorSearchPort (upsertPage/putChunks/pendingChunks/setVector/search) over OPFS SAH pool"
```

---

## Task 2: Create offscreen-worker-store.ts — VectorSearchPort adapter over the worker

This is a new file. It spawns ONE instance of the sqlite worker and turns each port method into a correlated request/response using a promise map. Float32Array values (for setVector and search) cross via postMessage structured clone — no conversion needed.

**Files:**
- Create: `src/offscreen/offscreen-worker-store.ts`

- [ ] **Step 1: Create the file**

```typescript
// OffscreenWorkerStore: implements VectorSearchPort by delegating to the
// sqlite-worker (OPFS SAH pool) via postMessage request/reply.
//
// Message format:
//   Request:  { id: number, op: string, args: unknown }
//   Reply OK: { id: number, result: unknown }
//   Reply ER: { id: number, error: string }
//
// Float32Array crosses the worker boundary via structured clone (postMessage),
// which preserves typed arrays in full — no number[] conversion needed.

import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class OffscreenWorkerStore implements VectorSearchPort {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingEntry>()
  private nextId = 0

  constructor() {
    this.worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data as { id: number; result?: unknown; error?: string }
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (error !== undefined) {
        entry.reject(new Error(error))
      } else {
        entry.resolve(result)
      }
    }
    this.worker.onerror = (e) => {
      console.error('[offscreen-worker-store] worker error:', e.message)
    }
  }

  private call<T>(op: string, args: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ id, op, args })
    })
  }

  upsertPage(page: CapturedPage): Promise<void> {
    return this.call('upsertPage', { page })
  }

  putChunks(pageId: string, chunks: Chunk[]): Promise<void> {
    return this.call('putChunks', { pageId, chunks })
  }

  pendingChunks(limit: number): Promise<Chunk[]> {
    return this.call<Chunk[]>('pendingChunks', { limit })
  }

  setVector(chunkId: string, vector: Float32Array): Promise<void> {
    // Float32Array is preserved by structured clone — no conversion.
    return this.call('setVector', { chunkId, vector })
  }

  search(queryVector: Float32Array, k: number): Promise<RankedResult[]> {
    // Float32Array is preserved by structured clone — no conversion.
    // The reply is RankedResult[] (plain objects only) — no typed arrays returned.
    return this.call<RankedResult[]>('search', { queryVector, k })
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
cd /Users/minhyeokkim/recall && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/minhyeokkim/recall
git add src/offscreen/offscreen-worker-store.ts
git commit -m "feat: add OffscreenWorkerStore — VectorSearchPort adapter over sqlite-worker (OPFS, structured-clone Float32Array)"
```

---

## Task 3: Update offscreen.ts — add core services, extend RPC handler

This is the biggest change to the offscreen. We:
1. Remove the old spike counter (worker/bumpCounter/pending/spike-bump listener)
2. Add OffscreenWorkerStore + core services (Capture/Indexing/Recall)
3. Add an EmbeddingPort adapter (WebGpuEmbedder returns number[][], core needs Float32Array[])
4. Extend the RPC handler with `capture`, `recall`, `ping` ops
5. Start the drain on load (resume any pending chunks from the previous session)
6. Push indexing-progress and indexing-complete rpc-events to the SW during drain

The bench poll timer and webgpu bench code (`_runBenchIfTriggered`) are kept — they are independent of the store.

**Files:**
- Modify: `src/offscreen/offscreen.ts`

- [ ] **Step 1: Replace offscreen.ts with the new version**

```typescript
// Offscreen document: the engine room.
// Owns: WebGpuEmbedder, OffscreenWorkerStore (OPFS via worker), and
//       the three core services (Capture, Indexing, Recall).
// Handles high-level RPC ops from the SW: capture, recall, ensureLoaded, ping.
// Drain (embedding queue) runs here so it stays alive independent of the SW.

import { installOffscreenRpcHandler } from './offscreen-rpc'
import { WebGpuEmbedder } from './webgpu-embedder'
import { OffscreenWorkerStore } from './offscreen-worker-store'
import { CaptureService } from '../core/capture-service'
import { IndexingService } from '../core/indexing-service'
import { RecallService } from '../core/recall-service'
import { ParagraphChunker } from '../core/paragraph-chunker'
import type { EmbeddingPort } from '../core/ports'

// ---------------------------------------------------------------------------
// Core services
// ---------------------------------------------------------------------------

const embedder = new WebGpuEmbedder()

// Adapter: WebGpuEmbedder.embed() returns number[][] (legacy type for RPC wire
// compatibility). Core services need Float32Array[]. Convert in one place.
const localEmbedder: EmbeddingPort = {
  async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const vecs = await embedder.embed(texts, kind)
    return vecs.map((a) => new Float32Array(a))
  },
}

const store = new OffscreenWorkerStore()
const chunker = new ParagraphChunker(220)
const capture = new CaptureService(chunker, store)
const indexing = new IndexingService(store, localEmbedder)
const recall = new RecallService(localEmbedder, store)

// ---------------------------------------------------------------------------
// Drain helper: run drain and push progress events to the SW.
// The SW relays them to the popup as indexing-progress broadcast messages.
// ---------------------------------------------------------------------------

function runDrainWithProgress(): void {
  let totalEmbedded = 0
  indexing
    .drain((n) => {
      totalEmbedded += n
      chrome.runtime
        .sendMessage({ channel: 'rpc-event', kind: 'indexing-progress', embedded: totalEmbedded })
        .catch(() => {})
    })
    .then(() => {
      // Signal "drain complete" so the popup shows "indexed".
      chrome.runtime
        .sendMessage({ channel: 'rpc-event', kind: 'indexing-complete', totalEmbedded })
        .catch(() => {})
    })
    .catch((e) => console.error('[recall/offscreen] drain failed:', e))
}

// On load: resume any pending chunks left from a previous session.
// The store worker may still be initialising its OPFS DB; pendingChunks() will
// wait for the worker's initPromise before replying, so this is safe to call now.
runDrainWithProgress()

// ---------------------------------------------------------------------------
// WebGPU bench (additive, independent of storage/core).
// ---------------------------------------------------------------------------

let _benchRunning = false

async function _runBenchIfTriggered(): Promise<void> {
  if (_benchRunning) return
  const data = (await chrome.storage.local.get(['__run_bench_trigger'])) as Record<string, unknown>
  if (data['__run_bench_trigger'] !== true) return
  _benchRunning = true
  await chrome.storage.local.remove(['__run_bench_trigger'])
  console.log('[recall/offscreen] webgpu-bench: trigger detected, starting...')
  await chrome.storage.local.set({ __webgpu_bench_started: Date.now() })
  try {
    const { runBench } = await import('./webgpu-bench')
    const result = await runBench()
    console.log('[recall/offscreen] webgpu-bench: DONE', result)
    await chrome.storage.local.set({ __webgpu_bench: { ...result, ts: Date.now() } })
  } catch (e) {
    const errResult = {
      webgpuMsPerChunk: null,
      wasm1MsPerChunk: null,
      wasmMultiMsPerChunk: null,
      crossOriginIsolated: false,
      accuracyCosine: null,
      webgpuDtype: null,
      notes: [`bench threw: ${String(e)}`],
      ts: Date.now(),
      error: String(e),
    }
    console.error('[recall/offscreen] webgpu-bench: FAILED', e)
    await chrome.storage.local.set({ __webgpu_bench: errResult })
  } finally {
    _benchRunning = false
  }
}

let _pollCount = 0
setInterval(() => {
  _pollCount++
  chrome.storage.local.set({ __offscreen_heartbeat: _pollCount }).catch(console.error)
  _runBenchIfTriggered().catch(console.error)
}, 2_000)

// ---------------------------------------------------------------------------
// RPC handler: dispatches on payload.op
// ---------------------------------------------------------------------------

installOffscreenRpcHandler(async (payload: unknown) => {
  const p = (payload ?? {}) as Record<string, unknown>
  const op = p.op as string | undefined

  // --- capture: store chunks immediately, fire-and-forget drain ---
  if (op === 'capture') {
    const url = p.url as string
    const title = p.title as string
    const text = p.text as string
    const t0 = Date.now()
    const { chunkCount } = await capture.capture({ url, title, text })
    console.log(`[recall/offscreen] capture done: ${chunkCount} chunks in ${Date.now() - t0}ms`)
    // Fire-and-forget: drain runs in background; the RPC reply returns immediately.
    runDrainWithProgress()
    return { chunkCount }
  }

  // --- recall: embed query, cosine search ---
  if (op === 'recall') {
    const text = p.text as string
    const k = p.k as number
    const t0 = Date.now()
    const results = await recall.recall({ text, k })
    console.log(`[recall/offscreen] recall done: ${results.length} results in ${Date.now() - t0}ms`)
    return { results }
  }

  // --- ensureLoaded: warm up the model, push progress events ---
  if (op === 'ensureLoaded') {
    await embedder.ensureLoaded((e) => {
      chrome.runtime
        .sendMessage({ channel: 'rpc-event', kind: 'model-progress', status: e })
        .catch(() => {})
    })
    console.log('[recall/offscreen] ensureLoaded done, device =', embedder.device)
    return { device: embedder.device, pipelineMs: embedder.pipelineMs, warmupMs: embedder.warmupMs }
  }

  // --- embed: kept for any callers that still use direct embed RPC (spike tests) ---
  if (op === 'embed') {
    const texts = (p.texts as string[]) ?? []
    const kind = (p.kind as 'query' | 'passage') ?? 'passage'
    const t0 = Date.now()
    const vectors = await embedder.embed(texts, kind)
    return { vectors, embedMs: Date.now() - t0, chunkCount: texts.length }
  }

  // --- ping: keep-alive from the SW ---
  if (op === 'ping') {
    return { pong: true }
  }

  // --- default: echo (keeps rpc-stress spike test green) ---
  return {
    echoed: payload,
    n: ((p.n as number) ?? 0) + 1,
  }
})

console.log('[recall/offscreen] document loaded, core services ready')
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
cd /Users/minhyeokkim/recall && npx tsc --noEmit
```

Expected: zero errors. Common pitfall: if WebGpuEmbedder.embed() has a different signature, check that `localEmbedder.embed()` matches `EmbeddingPort.embed(texts: string[], kind: 'query'|'passage'): Promise<Float32Array[]>`.

- [ ] **Step 3: Confirm core stays chrome-free**

```bash
cd /Users/minhyeokkim/recall && rg "chrome" src/core
```

Expected: empty output (no matches). If anything shows up, a core import leaked.

- [ ] **Step 4: Commit**

```bash
cd /Users/minhyeokkim/recall
git add src/offscreen/offscreen.ts
git commit -m "refactor: offscreen hosts core services (Capture/Indexing/Recall) + OPFS store; remove spike counter"
```

---

## Task 4: Update background/index.ts — SW becomes a thin relay

Strip out everything that moved to the offscreen (core services, store, embedder, drain). What remains: offscreen lifecycle, rpc-event relay, simple message forwarding, keep-alive ping, and the spike bench/rpc-stress code.

**Files:**
- Rewrite: `src/background/index.ts`

- [ ] **Step 1: Replace background/index.ts with the new version**

```typescript
// Service Worker: thin relay.
// Receives messages from popup/content, forwards to the offscreen via RPC,
// re-broadcasts progress events to the popup.
// No core services, no store, no embedder here.

import type { Msg, MsgResult } from '../messaging'
import type { RankedResult } from '../core/model'
import { INITIAL_MODEL_STATUS, reduceModelProgress } from '../core/model-progress'
import type { ModelStatus } from '../core/model-progress'
import {
  callOffscreen,
  installSwRpcListener,
  registerOffscreenEnsurer,
} from '../offscreen/offscreen-rpc'

// Vite's module-preload error handler calls window.dispatchEvent(), which does
// not exist in a service worker.
if (typeof window === 'undefined') {
  (self as unknown as { window: typeof globalThis }).window = self as unknown as typeof globalThis
}

console.log('[recall/bg] service worker evaluated (thin relay)')

const _t0Startup = Date.now()

// ---------------------------------------------------------------------------
// Offscreen lifecycle
// ---------------------------------------------------------------------------

let _offscreenDocP: Promise<void> | null = null

function ensureOffscreen(): Promise<void> {
  if (_offscreenDocP) return _offscreenDocP
  _offscreenDocP = (async () => {
    const exists = await chrome.offscreen?.hasDocument?.()
    if (exists) return
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
      reasons: ['BLOBS'],
      justification: 'OPFS sqlite + WebGPU embedder via offscreen document',
    })
  })()
  return _offscreenDocP
}

function resetOffscreen(): void {
  _offscreenDocP = null
}

installSwRpcListener()
registerOffscreenEnsurer(ensureOffscreen, resetOffscreen)

// ---------------------------------------------------------------------------
// Model status (SW tracks the latest status from rpc-events; popup reads it)
// ---------------------------------------------------------------------------

let modelStatus: ModelStatus = INITIAL_MODEL_STATUS

function broadcastModelStatus(status: ModelStatus): void {
  chrome.runtime.sendMessage({ type: 'model-progress', status }).catch(() => {})
}

function broadcastIndexingProgress(pending: number, embedded: number): void {
  chrome.runtime.sendMessage({ type: 'indexing-progress', pending, embedded }).catch(() => {})
}

// ---------------------------------------------------------------------------
// rpc-event relay: offscreen -> SW -> popup
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: any): boolean => {
  if (msg?.channel !== 'rpc-event') return false

  if (msg?.kind === 'model-progress') {
    const e = msg.status as { status: string; progress?: number }
    console.log('[recall/bg] model progress:', e.status, e.progress ?? '')
    modelStatus = reduceModelProgress(modelStatus, e)
    broadcastModelStatus(modelStatus)
  } else if (msg?.kind === 'indexing-progress') {
    // pending=1 means "still going"; embedded is the running total.
    broadcastIndexingProgress(1, (msg.embedded as number) ?? 0)
  } else if (msg?.kind === 'indexing-complete') {
    // pending=0 signals "done" to the popup UI.
    const total = (msg.totalEmbedded as number) ?? 0
    broadcastIndexingProgress(0, total)
    if (total > 0) {
      modelStatus = { state: 'ready', percent: 100 }
      broadcastModelStatus(modelStatus)
    }
  }

  return false
})

// ---------------------------------------------------------------------------
// Message router: capture / recall / model-status -> offscreen RPC
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === 'model-status') {
    sendResponse({ type: 'model-status', status: modelStatus } satisfies MsgResult)
    return true
  }

  if (msg.type !== 'capture' && msg.type !== 'recall') return false

  ;(async () => {
    try {
      await ensureOffscreen()

      if (msg.type === 'capture') {
        console.log('[recall/bg] capture: forwarding to offscreen, text length =', msg.text.length)
        const t0 = Date.now()
        const r = await callOffscreen<{ chunkCount: number }>({
          op: 'capture',
          url: msg.url,
          title: msg.title,
          text: msg.text,
        })
        console.log(`[timing] capture store (incl. offscreen RPC) = ${Date.now() - t0} ms`)
        sendResponse({ type: 'captured', chunkCount: r.chunkCount } satisfies MsgResult)
      } else if (msg.type === 'recall') {
        const r = await callOffscreen<{ results: RankedResult[] }>({
          op: 'recall',
          text: msg.text,
          k: msg.k,
        })
        console.log('[recall/bg] recall: DONE, results =', r.results.length)
        modelStatus = { state: 'ready', percent: 100 }
        broadcastModelStatus(modelStatus)
        sendResponse({ type: 'recalled', results: r.results } satisfies MsgResult)
      }
    } catch (err) {
      console.error('[recall/bg]', msg.type, 'FAILED:', err)
      modelStatus = { state: 'error', percent: modelStatus.percent }
      broadcastModelStatus(modelStatus)
      sendResponse({ type: 'error', error: String(err) } satisfies MsgResult)
    }
  })()
  return true
})

// ---------------------------------------------------------------------------
// onInstalled: pre-warm model in offscreen
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log('[recall/bg] onInstalled: pre-warming model in offscreen...')
  ;(async () => {
    await ensureOffscreen()
    const r = await callOffscreen<{ device: string; pipelineMs?: number; warmupMs?: number }>({
      op: 'ensureLoaded',
    })
    const startupToModelMs = Date.now() - _t0Startup
    console.log('[recall/bg] pre-warm complete: device =', r.device)
    console.log(`[timing] startup->model ready = ${startupToModelMs} ms`)
    modelStatus = { state: 'ready', percent: 100 }
    broadcastModelStatus(modelStatus)
  })().catch((e) => {
    console.error('[recall/bg] pre-warm FAILED:', e)
    modelStatus = { state: 'error', percent: modelStatus.percent }
  })
})

// ---------------------------------------------------------------------------
// Keep-alive: ping the offscreen every 25s so Chrome does not reap it.
// This keeps the model resident across captures.
// ---------------------------------------------------------------------------

setInterval(() => {
  callOffscreen({ op: 'ping' }).catch(() => {})
}, 25_000)

// ---------------------------------------------------------------------------
// Spike: run-webgpu-bench relay (additive, unchanged)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg.type !== 'run-webgpu-bench') return false
  ;(async () => {
    try {
      await ensureOffscreen()
      await chrome.storage.local.set({ __run_bench_trigger: true })
      sendResponse({ status: 'started' })
    } catch (e) {
      sendResponse({ status: 'error', error: String(e) })
    }
  })()
  return true
})

// ---------------------------------------------------------------------------
// Spike: rpc-stress handler (additive, unchanged)
// Tests N concurrent callOffscreen() round-trips and reports delivery stats.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg?.type !== 'rpc-stress') return false
  ;(async () => {
    const count: number = Number(msg.count) || 0
    const t0 = Date.now()
    await ensureOffscreen()
    const settled = await Promise.allSettled(
      Array.from({ length: count }, (_, i) =>
        callOffscreen<{ echoed: unknown; n: number }>({ n: i }),
      ),
    )
    let ok = 0, mismatches = 0, missing = 0
    for (let i = 0; i < count; i++) {
      const r = settled[i]
      if (r.status === 'rejected') {
        missing++
      } else {
        const n = (r.value as any)?.n
        if (n === i + 1) ok++
        else mismatches++
      }
    }
    const elapsedMs = Date.now() - t0
    console.log(`[rpc-stress] done: total=${count} ok=${ok} mismatches=${mismatches} missing=${missing} elapsedMs=${elapsedMs}`)
    sendResponse({ total: count, ok, mismatches, missing, elapsedMs })
  })()
  return true
})
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
cd /Users/minhyeokkim/recall && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Confirm core stays chrome-free**

```bash
cd /Users/minhyeokkim/recall && rg "chrome" src/core
```

Expected: empty output.

- [ ] **Step 4: Run vitest unit tests**

```bash
cd /Users/minhyeokkim/recall && npm test
```

Expected: all unit tests pass. These use MemoryVectorStore and fake embedders — the SW refactor does not touch them.

- [ ] **Step 5: Commit**

```bash
cd /Users/minhyeokkim/recall
git add src/background/index.ts
git commit -m "refactor: SW is now a thin relay — remove core services/store/embedder, forward capture/recall to offscreen via RPC, add 25s keep-alive ping"
```

---

## Task 5: Create persistence.spec.ts — e2e proof that data survives restart

This test proves the headline benefit: because the store is now OPFS-backed (running in the offscreen worker), captured data persists across a full browser restart. The test launches Chrome twice with the same user-data-dir and asserts that a search in the second session returns Cortisol first — without re-capturing.

**Files:**
- Create: `tests/e2e/persistence.spec.ts`

- [ ] **Step 1: Create persistence.spec.ts**

```typescript
// Scenario: captured data (chunks + vectors) must survive a full browser restart,
// proving that storage is now OPFS-durable (not in-memory).
// Without the offscreen+worker+OPFS refactor this test always fails on run 2.
// Coverage: integration (two real Chrome instances, same userDataDir, real OPFS).

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')
// Fixed profile so OPFS data persists between the two launches.
const PROFILE = path.join(os.tmpdir(), 'recall-persistence-e2e-profile')

async function launchCtx() {
  return chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
    ],
  })
}

async function getExtId(ctx: Awaited<ReturnType<typeof launchCtx>>): Promise<string> {
  const swPromise = ctx.waitForEvent('serviceworker', { timeout: 30_000 }).catch(() => null)
  const existingSw = ctx.serviceWorkers()[0]
  const sw = existingSw ?? (await swPromise)
  if (!sw) throw new Error('service worker never started')
  return sw.url().split('/')[2]
}

test('captured data survives a full browser restart (OPFS persistence)', async () => {
  test.setTimeout(360_000)

  // Clean slate — ensures run starts with empty OPFS.
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true })

  // ==========================================================================
  // Session 1: capture the article, wait for indexing, verify search works.
  // ==========================================================================
  const ctx1 = await launchCtx()
  try {
    const extId = await getExtId(ctx1)

    const articlePage = await ctx1.newPage()
    await articlePage.goto('file://' + path.resolve(dir, 'fixtures/article.html'))

    const popup1 = await ctx1.newPage()
    await popup1.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

    // Keep the article page in front for the capture.
    await articlePage.bringToFront()

    // Capture.
    await popup1.getByText('Capture this page').click()
    await expect(popup1.getByText('captured', { exact: false })).toBeVisible({ timeout: 30_000 })

    // Wait for indexing (model download + embed).
    await expect(popup1.getByText('indexed')).toBeVisible({ timeout: 240_000 })

    // Quick sanity: Cortisol ranks first in session 1.
    await popup1.getByPlaceholder('recall...').fill('hormone that ruins sleep')
    await popup1.getByPlaceholder('recall...').press('Enter')
    const items1 = popup1.locator('li')
    await expect(items1).toHaveCount(2, { timeout: 30_000 })
    await expect(items1.first()).toContainText('Cortisol', { timeout: 10_000 })

    console.log('[persistence] session 1 OK — Cortisol ranked first, closing context...')
  } finally {
    await ctx1.close()
  }

  // Give Chrome time to release the profile directory lock.
  await new Promise<void>((r) => setTimeout(r, 3_000))

  // ==========================================================================
  // Session 2: same profile, NO capture. Assert Cortisol still ranks first.
  // ==========================================================================
  const ctx2 = await launchCtx()
  try {
    const extId = await getExtId(ctx2)

    const popup2 = await ctx2.newPage()
    await popup2.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

    // Do NOT capture. Just search immediately.
    await popup2.getByPlaceholder('recall...').fill('hormone that ruins sleep')
    await popup2.getByPlaceholder('recall...').press('Enter')

    // Cortisol must still rank first — from the OPFS-persisted data.
    const items2 = popup2.locator('li')
    await expect(items2).toHaveCount(2, { timeout: 30_000 })
    await expect(items2.first()).toContainText('Cortisol', { timeout: 10_000 })

    console.log('[persistence] session 2 OK — Cortisol ranked first WITHOUT re-capturing. OPFS persistence confirmed.')
  } finally {
    await ctx2.close()
  }
})
```

- [ ] **Step 2: Verify the test file has no TypeScript errors**

```bash
cd /Users/minhyeokkim/recall && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/minhyeokkim/recall
git add tests/e2e/persistence.spec.ts
git commit -m "test: add persistence.spec.ts — e2e proof that OPFS data survives browser restart (Cortisol ranks first in session 2 without re-capturing)"
```

---

## Task 6: Delete obsolete test, build, and verify all checks pass

The `sqlite-vector-store.spec.ts` test exercised the old in-SW sqlite store via a Vite-served fixture. That path no longer exists (the store moved into the worker). Delete it and run all verification steps.

**Files:**
- Delete: `tests/e2e/sqlite-vector-store.spec.ts`

- [ ] **Step 1: Delete the obsolete test**

```bash
cd /Users/minhyeokkim/recall && rm tests/e2e/sqlite-vector-store.spec.ts
```

- [ ] **Step 2: Run vitest unit tests**

```bash
cd /Users/minhyeokkim/recall && npm test
```

Expected: all tests pass. Look for output like `✓ tests/core/capture-service.test.ts` etc. No failures. If a test touches `SqliteVectorStore` (the adapter still exists), that test uses in-memory sqlite via the `SqliteDb` interface and is NOT affected by the store moving to the worker.

- [ ] **Step 3: TypeScript check**

```bash
cd /Users/minhyeokkim/recall && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Build**

```bash
cd /Users/minhyeokkim/recall && npm run build
```

Expected: build succeeds with output to `dist-ext/`. The sqlite worker (`sqlite-worker.ts`) and the offscreen worker store will be bundled as separate worker chunks.

- [ ] **Step 5: Confirm core is chrome-free**

```bash
cd /Users/minhyeokkim/recall && rg "chrome" src/core
```

Expected: no output (empty). All chrome API calls live in `src/background/` and `src/offscreen/` only.

- [ ] **Step 6: Run recall-flow e2e test**

```bash
cd /Users/minhyeokkim/recall && npx playwright test tests/e2e/recall-flow.spec.ts
```

Expected: the test passes — captures the article, waits for indexing, and verifies Cortisol ranks first AND bookkeeping ranks first for the tax query. Allow up to 270s (model download on first run).

- [ ] **Step 7: Run persistence e2e test**

```bash
cd /Users/minhyeokkim/recall && npx playwright test tests/e2e/persistence.spec.ts
```

Expected: the test passes — Cortisol found without re-capturing in session 2. Allow up to 360s.

- [ ] **Step 8: Commit**

```bash
cd /Users/minhyeokkim/recall
git add tests/e2e/sqlite-vector-store.spec.ts  # the deletion
git commit -m "chore: delete sqlite-vector-store.spec.ts (tests old in-SW store path; real store is now in the offscreen worker)"
```

---

## Self-Review Checklist

| Check | Where it is verified |
|-------|----------------------|
| Data persists across restart | `persistence.spec.ts` passes (Cortisol in session 2 without re-capture) |
| Core untouched, no chrome | `rg "chrome" src/core` → empty |
| SW is thin relay (no store/embedder/core) | `background/index.ts` has no CaptureService/RecallService/IndexingService/SqliteVectorStore imports |
| recall-flow still green | `playwright test recall-flow.spec.ts` passes |
| No Float32Array crosses chrome.runtime | capture RPC returns `{chunkCount: number}`, recall RPC returns `{results: RankedResult[]}` — all plain objects. Vectors only cross offscreen↔worker (postMessage structured clone). |
| Offscreen stays alive | `ensureOffscreen` never calls `closeDocument()`; keep-alive ping every 25s |
| npm test green | All vitest core tests pass (use MemoryVectorStore, unaffected) |
| tsc clean | `npx tsc --noEmit` zero errors |
| Build clean | `npm run build` exits 0 |

---

## Known Constraints and Gotchas

**Model progress during startup drain:** When the offscreen loads and immediately starts the drain, if the drain triggers model loading before the SW's `onInstalled` calls `ensureLoaded`, the WebGPU pipeline will load without an `onProgress` callback, so no download progress events reach the popup. This only affects the very first install when both happen simultaneously. On subsequent sessions, the model is already cached; loading is instant and no progress UI is needed. This is acceptable.

**Single worker instance:** `OffscreenWorkerStore` spawns exactly one worker. The old spike counter code in `offscreen.ts` previously also spawned a worker for `sqlite-worker.ts`. After this refactor, the spike counter code is removed — only one worker runs.

**OPFS pool name collision:** The spike used pool name `'recall-spike-pool'` and file `/spike.sqlite3`. The real worker uses `'recall-pool'` and `/recall.sqlite3`. If the spike-persistence test ran previously and left the spike profile, that file is unrelated and harmless.

**rpc-stress and echo op:** The `rpc-stress` spike test sends `callOffscreen({ n: i })` which hits the echo default case in the RPC handler. That default case is preserved in the new `offscreen.ts`, so `spike-messaging.spec.ts` still passes.

**sqlite-vector-store.spec.ts deletion:** The Playwright config (`playwright.config.ts`) uses `testDir: 'tests/e2e'` which picks up all `.spec.ts` files there. Deleting this file removes it from the run. The fixture file `tests/e2e/fixtures/sqlite-test.html` can be left in place (harmless orphan) or deleted; do not delete it if any other test references it.

import { IndexingService } from '../../src/core/indexing-service'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import { CaptureService } from '../../src/core/capture-service'
import { ParagraphChunker } from '../../src/core/paragraph-chunker'
import type { EmbeddingPort } from '../../src/core/ports'

// Fake embedder: returns a deterministic unit vector per text.
function makeEmbedder(spy?: { count: number }): EmbeddingPort {
  return {
    async embed(texts, _kind) {
      if (spy) spy.count += texts.length
      return texts.map((_, i) => new Float32Array([Math.cos(i), Math.sin(i)]))
    },
  }
}

// Scenario: after capture stores pending chunks, drain must embed them all and make
// them searchable; pendingChunks must be empty afterward.
// Coverage: integration (real MemoryVectorStore, fake embedder).
test('drain embeds all pending chunks and makes them searchable', async () => {
  const store = new MemoryVectorStore()
  const embedder = makeEmbedder()
  const capture = new CaptureService(new ParagraphChunker(220), store)
  const indexing = new IndexingService(store, embedder)

  await capture.capture({ url: 'http://x/a', title: 'A', text: 'cortisol disrupts sleep\n\ntax accounting basics' })

  // Before drain: not searchable.
  expect((await store.search(new Float32Array([1, 0]), '', 10)).length).toBe(0)
  expect((await store.pendingChunks(100)).length).toBeGreaterThan(0)

  await indexing.drain()

  // After drain: searchable; nothing pending.
  expect((await store.search(new Float32Array([1, 0]), '', 10)).length).toBeGreaterThan(0)
  expect((await store.pendingChunks(100)).length).toBe(0)
})

// Scenario: two concurrent drain() calls must not double-embed the same chunk.
// Coverage: integration (spy counts embed calls; asserts each chunk embedded once).
test('single-flight: concurrent drains do not double-embed', async () => {
  const store = new MemoryVectorStore()
  const spy = { count: 0 }
  const embedder = makeEmbedder(spy)
  const capture = new CaptureService(new ParagraphChunker(220), store)
  const indexing = new IndexingService(store, embedder)

  await capture.capture({ url: 'http://x/a', title: 'A', text: 'hello world today' })
  const chunkCount = (await store.pendingChunks(100)).length

  // Fire two drains concurrently.
  await Promise.all([indexing.drain(), indexing.drain()])

  // Each chunk must have been embedded exactly once.
  expect(spy.count).toBe(chunkCount)
  expect((await store.pendingChunks(100)).length).toBe(0)
})

// Scenario: embedding fails on batch 2 of 3 (e.g. WebGPU blip). With maxRetries=0
// (no retry), the drain stops gracefully after the first failure: resolves (no throw),
// keeps the first batch searchable, and leaves the rest pending for a later re-drain.
// Coverage: integration (real MemoryVectorStore; fake embedder throws on 2nd batch).
test('drain stops gracefully on embed failure; first batch persisted, rest stay pending', async () => {
  const store = new MemoryVectorStore()
  const capture = new CaptureService(new ParagraphChunker(1), store) // maxWords=1 -> one chunk per word
  await capture.capture({ url: 'http://x/a', title: 'A', text: 'alpha beta gamma' })
  const total = (await store.pendingChunks(100)).length
  expect(total).toBe(3)

  let embedCalls = 0
  const flakyEmbedder: EmbeddingPort = {
    async embed(texts) {
      embedCalls++
      if (embedCalls === 2) throw new Error('embed boom on batch 2')
      return texts.map(() => new Float32Array([1, 0]))
    },
  }
  // maxRetries=0 means no retries: a single failure immediately stops the drain.
  const indexing = new IndexingService(store, flakyEmbedder, 1, 0) // batch=1, maxRetries=0

  // drain resolves (does not throw) - failure is handled gracefully.
  await indexing.drain()

  // First batch persisted: exactly one chunk is now searchable.
  expect((await store.search(new Float32Array([1, 0]), '', 100)).length).toBe(1)
  // The rest stay pending so a later ping/startup/capture re-drain can finish them.
  expect((await store.pendingChunks(100)).length).toBe(total - 1)
})

// Scenario: drain on an empty store must be a no-op (no errors, no embed calls).
// Coverage: integration (real store with no data, fake embedder with spy).
test('drain on empty store is a no-op', async () => {
  const store = new MemoryVectorStore()
  const spy = { count: 0 }
  const embedder = makeEmbedder(spy)
  const indexing = new IndexingService(store, embedder)

  await indexing.drain()

  expect(spy.count).toBe(0)
})

// --- New retry tests (TDD - written before implementation) ---

const noSleep = async () => {}

// Scenario: A transient embed failure (e.g. GPU hiccup) must not strand a chunk as
// unsearchable. The drain retries and the chunk eventually gets its vector.
// Coverage: integration (real IndexingService + MemoryVectorStore; injected no-op sleep).
test('retries a transient embed failure until it succeeds', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage({ id: 'p', url: 'u', title: 't', capturedAt: 0 })
  await store.putChunks('p', [{ id: 'c0', pageId: 'p', index: 0, text: 'hello world' }])

  let calls = 0
  const embedder = {
    embed: async (texts: string[]) => {
      calls++
      if (calls < 3) throw new Error('gpu hiccup')
      return texts.map(() => new Float32Array([1, 0]))
    },
    ensureLoaded: async () => {},
  }
  const svc = new IndexingService(store as any, embedder as any, 32, 3, noSleep)
  await svc.drain()

  expect(calls).toBe(3) // failed twice, succeeded on the 3rd
  expect((await store.pendingChunks(10)).length).toBe(0) // chunk got embedded
})

// Scenario: A persistent embed failure (model completely dead) must not throw or loop
// forever. The drain resolves, leaving the chunk pending for a later re-drain.
// Coverage: integration (real IndexingService + MemoryVectorStore; always-failing embedder).
test('persistent embed failure stops gracefully: no throw, chunk stays pending', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage({ id: 'p', url: 'u', title: 't', capturedAt: 0 })
  await store.putChunks('p', [{ id: 'c0', pageId: 'p', index: 0, text: 'hello world' }])

  const embedder = { embed: async () => { throw new Error('model dead') }, ensureLoaded: async () => {} }
  const svc = new IndexingService(store as any, embedder as any, 32, 2, noSleep)

  await expect(svc.drain()).resolves.toBeUndefined() // does NOT throw
  expect((await store.pendingChunks(10)).length).toBe(1) // still pending, not lost
})

// Scenario: onBatch callback must be called once per batch processed.
// Coverage: integration (fake embedder, 2-chunk batch size forces two iterations for 3 chunks).
test('onBatch is called for each processed batch', async () => {
  const store = new MemoryVectorStore()
  const embedder = makeEmbedder()
  const capture = new CaptureService(new ParagraphChunker(5), store) // small chunk size -> multiple chunks
  const indexing = new IndexingService(store, embedder, 1) // batch=1 -> one call per chunk

  // Three paragraphs, each < 5 words but forced separate by chunker.
  await capture.capture({
    url: 'http://x/a',
    title: 'A',
    text: 'alpha\n\nbeta\n\ngamma',
  })
  const chunkCount = (await store.pendingChunks(100)).length

  const batchCounts: number[] = []
  await indexing.drain((n) => batchCounts.push(n))

  expect(batchCounts.length).toBe(chunkCount) // one call per chunk (batch=1)
  expect(batchCounts.every((n) => n === 1)).toBe(true)
})

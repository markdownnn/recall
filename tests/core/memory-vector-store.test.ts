import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { CapturedPage, Chunk } from '../../src/core/model'

const page: CapturedPage = { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 }
const chunkA: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'cortisol and sleep' }
const chunkB: Chunk = { id: 'p1#1', pageId: 'p1', index: 1, text: 'tax accounting basics' }

test('chunk is not searchable until setVector is called', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.putChunks('p1', [chunkA, chunkB])
  // No vectors yet: search must return nothing.
  const results = await store.search(new Float32Array([1, 0]), 10)
  expect(results.length).toBe(0)
})

test('pendingChunks returns un-vectored chunks', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.putChunks('p1', [chunkA, chunkB])
  // Both chunks are pending.
  const pending1 = await store.pendingChunks(10)
  expect(pending1.length).toBe(2)
  // After setting a vector, only one remains pending.
  await store.setVector('p1#0', new Float32Array([1, 0]))
  const pending2 = await store.pendingChunks(10)
  expect(pending2.length).toBe(1)
  expect(pending2[0].id).toBe('p1#1')
})

test('ranks the nearest chunk first after setVector', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.putChunks('p1', [chunkA, chunkB])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  await store.setVector('p1#1', new Float32Array([0, 1]))

  const results = await store.search(new Float32Array([0.9, 0.1]), 2)
  expect(results[0].chunk.id).toBe('p1#0')
  expect(results[0].page.id).toBe('p1')
  expect(results[0].score).toBeGreaterThan(results[1].score)
})

test('respects k', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.putChunks('p1', [chunkA, chunkB])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  await store.setVector('p1#1', new Float32Array([0, 1]))
  expect((await store.search(new Float32Array([1, 0]), 1)).length).toBe(1)
})

test('excludes a chunk whose page is missing', async () => {
  const store = new MemoryVectorStore()
  // putChunks + setVector without upsertPage.
  await store.putChunks('p1', [chunkA])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  expect((await store.search(new Float32Array([1, 0]), 5)).length).toBe(0)
})

test('putChunks replaces page chunks - re-capture with fewer chunks leaves no stale', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.putChunks('p1', [chunkA, chunkB])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  await store.setVector('p1#1', new Float32Array([0, 1]))

  // Re-put with only one chunk: stale chunkB must be gone.
  await store.putChunks('p1', [chunkA])
  await store.setVector('p1#0', new Float32Array([1, 0]))

  const results = await store.search(new Float32Array([1, 0]), 10)
  expect(results.length).toBe(1)
  expect(results[0].chunk.id).toBe('p1#0')
})

test('search excludes pending chunks (vector not yet set)', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.putChunks('p1', [chunkA, chunkB])
  // Only embed one chunk.
  await store.setVector('p1#0', new Float32Array([1, 0]))

  const results = await store.search(new Float32Array([1, 0]), 10)
  expect(results.length).toBe(1)
  expect(results[0].chunk.id).toBe('p1#0')
})

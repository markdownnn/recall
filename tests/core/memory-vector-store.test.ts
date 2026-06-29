import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { CapturedPage, Chunk } from '../../src/core/model'

const page: CapturedPage = { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 }
const chunkA: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'cortisol and sleep' }
const chunkB: Chunk = { id: 'p1#1', pageId: 'p1', index: 1, text: 'tax accounting basics' }

test('ranks the nearest chunk first', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.upsertChunk(chunkA, new Float32Array([1, 0]))
  await store.upsertChunk(chunkB, new Float32Array([0, 1]))

  const results = await store.search(new Float32Array([0.9, 0.1]), 2)
  expect(results[0].chunk.id).toBe('p1#0')
  expect(results[0].page.id).toBe('p1')
  expect(results[0].score).toBeGreaterThan(results[1].score)
})

test('respects k', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.upsertChunk(chunkA, new Float32Array([1, 0]))
  await store.upsertChunk(chunkB, new Float32Array([0, 1]))
  expect((await store.search(new Float32Array([1, 0]), 1)).length).toBe(1)
})

test('excludes a chunk whose page is missing', async () => {
  const store = new MemoryVectorStore()
  // chunk upserted without its page
  await store.upsertChunk(chunkA, new Float32Array([1, 0]))
  expect((await store.search(new Float32Array([1, 0]), 5)).length).toBe(0)
})

test('clearChunks removes all chunks for the page and search returns 0', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.upsertChunk(chunkA, new Float32Array([1, 0]))
  await store.upsertChunk(chunkB, new Float32Array([0, 1]))

  await store.clearChunks('p1')

  const results = await store.search(new Float32Array([1, 0]), 10)
  expect(results.length).toBe(0)
})

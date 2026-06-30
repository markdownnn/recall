import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { CapturedPage, Chunk } from '../../src/core/model'

const page: CapturedPage = { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 }
const chunkA: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'cortisol and sleep' }
const chunkB: Chunk = { id: 'p1#1', pageId: 'p1', index: 1, text: 'tax accounting basics' }

// Scenario: the side panel shows a SAVED badge for the current tab. The badge asks the
// store "do we already have this page?"; it is false before capture and true after.
// Coverage: integration (real MemoryVectorStore - the VectorSearchPort contract).
test('hasPage is false until a page is upserted, then true', async () => {
  const store = new MemoryVectorStore()
  expect(await store.hasPage('p1')).toBe(false)
  await store.upsertPage({ id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 })
  expect(await store.hasPage('p1')).toBe(true)
  expect(await store.hasPage('nope')).toBe(false)
})

// Scenario: the History tab lists captured pages newest-first; a fresh install has none,
// and after capturing pages they come back in reverse-chronological order.
// Coverage: integration (real MemoryVectorStore - the VectorSearchPort contract).
test('recentPages returns pages newest-first', async () => {
  const store = new MemoryVectorStore()
  expect(await store.recentPages(10)).toEqual([])
  await store.upsertPage({ id: 'a', url: 'http://a', title: 'A', capturedAt: 100 })
  await store.upsertPage({ id: 'b', url: 'http://b', title: 'B', capturedAt: 300 })
  await store.upsertPage({ id: 'c', url: 'http://c', title: 'C', capturedAt: 200 })
  const ids = (await store.recentPages(10)).map((p) => p.id)
  expect(ids).toEqual(['b', 'c', 'a'])
})

// Scenario: a large corpus must page in, not load all at once; limit caps the first page.
// Coverage: integration (real MemoryVectorStore).
test('recentPages caps the result at limit', async () => {
  const store = new MemoryVectorStore()
  for (let i = 0; i < 5; i++) await store.upsertPage({ id: String(i), url: 'http://x/' + i, title: 'P' + i, capturedAt: i })
  expect((await store.recentPages(2)).map((p) => p.id)).toEqual(['4', '3'])
})

// Scenario: "Load more" asks for the next page using the last row's capturedAt as a cursor;
// only strictly-older pages come back, so paging never repeats or skips a row.
// Coverage: integration (real MemoryVectorStore).
test('recentPages pages by the beforeTs cursor', async () => {
  const store = new MemoryVectorStore()
  for (let i = 1; i <= 5; i++) await store.upsertPage({ id: String(i), url: 'http://x/' + i, title: 'P' + i, capturedAt: i * 10 })
  const page1 = await store.recentPages(2)              // [50, 40]
  expect(page1.map((p) => p.id)).toEqual(['5', '4'])
  const page2 = await store.recentPages(2, page1[page1.length - 1].capturedAt) // before 40 -> [30, 20]
  expect(page2.map((p) => p.id)).toEqual(['3', '2'])
})

test('chunk is not searchable until setVector is called', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.putChunks('p1', [chunkA, chunkB])
  // No vectors yet: search must return nothing.
  const results = await store.search(new Float32Array([1, 0]), '', 10)
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

// Scenario: a single busy page with far more chunks than the candidate cap must not
// monopolize the candidate lanes and crowd out other matching pages; document-level
// recall should still surface k DISTINCT pages.
// Coverage: integration (real MemoryVectorStore hybrid path + topPagesBySnippet).
test('busy page does not crowd out other pages', async () => {
  const store = new MemoryVectorStore()
  // pBig: 60 chunks (more than the N=50 cap), all vectors equal to the query.
  const bigPage: CapturedPage = { id: 'pBig', url: 'http://big', title: 'BIG', capturedAt: 1 }
  await store.upsertPage(bigPage)
  const bigChunks: Chunk[] = []
  for (let i = 0; i < 60; i++) {
    bigChunks.push({ id: `pBig#${i}`, pageId: 'pBig', index: i, text: `big chunk ${i}` })
  }
  await store.putChunks('pBig', bigChunks)
  for (let i = 0; i < 60; i++) {
    await store.setVector(`pBig#${i}`, new Float32Array([1, 0]))
  }
  // 5 other pages, each a single chunk slightly farther from the query.
  for (let p = 0; p < 5; p++) {
    const id = `pOther${p}`
    await store.upsertPage({ id, url: `http://o${p}`, title: id.toUpperCase(), capturedAt: 1 })
    await store.putChunks(id, [{ id: `${id}#0`, pageId: id, index: 0, text: `other ${p}` }])
    await store.setVector(`${id}#0`, new Float32Array([0.7, 0.7]))
  }

  const results = await store.search(new Float32Array([1, 0]), '', 5)
  const pageIds = results.map((x) => x.page.id)
  // 5 DISTINCT pages: pBig once + 4 others, NOT just pBig flooding the cap.
  expect(new Set(pageIds).size).toBe(5)
  expect(pageIds).toContain('pBig')
})

test('respects k', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.putChunks('p1', [chunkA, chunkB])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  await store.setVector('p1#1', new Float32Array([0, 1]))
  expect((await store.search(new Float32Array([1, 0]), '', 1)).length).toBe(1)
})

test('excludes a chunk whose page is missing', async () => {
  const store = new MemoryVectorStore()
  // putChunks + setVector without upsertPage.
  await store.putChunks('p1', [chunkA])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  expect((await store.search(new Float32Array([1, 0]), '', 5)).length).toBe(0)
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

  const results = await store.search(new Float32Array([1, 0]), '', 10)
  expect(results.length).toBe(1)
  expect(results[0].chunk.id).toBe('p1#0')
})

test('search excludes pending chunks (vector not yet set)', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage(page)
  await store.putChunks('p1', [chunkA, chunkB])
  // Only embed one chunk.
  await store.setVector('p1#0', new Float32Array([1, 0]))

  const results = await store.search(new Float32Array([1, 0]), '', 10)
  expect(results.length).toBe(1)
  expect(results[0].chunk.id).toBe('p1#0')
})

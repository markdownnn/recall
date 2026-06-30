import { CaptureService, pageIdFromUrl } from '../../src/core/capture-service'
import { ParagraphChunker } from '../../src/core/paragraph-chunker'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'

// Scenario: a user saves an article via a clean link, then re-visits it via a campaign
// link (?utm_source=...). The page must dedup to ONE id, or it saves twice and the
// SAVED badge misreads. Pins the guarantee directly on pageIdFromUrl (not just the helper).
// Coverage: integration (real exported pageIdFromUrl).
test('pageIdFromUrl gives a campaign link and a clean link the same id', () => {
  expect(pageIdFromUrl('https://x.com/a?utm_source=s&id=1')).toBe(pageIdFromUrl('https://x.com/a?id=1'))
})

// Scenario: capturing a page must store chunks as pending and return a chunk count.
// Coverage: integration (real chunker + real MemoryVectorStore).
test('capture stores chunks as pending and returns chunkCount', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), store)

  const result = await svc.capture({ url: 'http://x/a', title: 'A', text: 'one two\n\nthree four five' })

  expect(result.chunkCount).toBeGreaterThan(0)
  // Chunks must be pending (no vector yet), so search returns nothing.
  const results = await store.search(new Float32Array([1, 0]), '', 10)
  expect(results.length).toBe(0)
  // But pendingChunks shows them.
  const pending = await store.pendingChunks(100)
  expect(pending.length).toBe(result.chunkCount)
})

// Scenario: re-capture of same URL must replace old chunks; no stale chunks remain.
// Coverage: integration (real chunker + real MemoryVectorStore).
test('re-capture of same URL replaces chunks - no stale entries', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), store)

  // First capture: 3 paragraphs merge into 1 chunk (word-stream, 9 words < 220).
  await svc.capture({ url: 'http://x/a', title: 'A', text: 'para one\n\npara two\n\npara three' })

  // Second capture: 1 paragraph -> 1 chunk.
  const result2 = await svc.capture({ url: 'http://x/a', title: 'A', text: 'only one para' })

  // Only the new chunks must be pending.
  const pending = await store.pendingChunks(100)
  expect(pending.length).toBe(result2.chunkCount)
  expect(pending[0].text).toBe('only one para')
})

// Scenario: empty page text must return chunkCount: 0 and leave the store unchanged.
// Coverage: integration (real chunker returns empty array for blank text).
test('empty text returns chunkCount 0 and does not touch the store', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), store)

  const result = await svc.capture({ url: 'http://x/a', title: 'A', text: '' })

  expect(result.chunkCount).toBe(0)
  expect(await store.pendingChunks(100)).toHaveLength(0)
})

// Scenario: credentials in a URL must not create a duplicate entry vs the clean URL.
// Coverage: integration (fake store; asserts single page via pendingChunks count).
test('URLs differing only in credentials map to the same stored page', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), store)

  // First capture uses a URL with embedded credentials.
  await svc.capture({ url: 'https://user:pass@example.com/a', title: 'A', text: 'hello world' })
  // Second capture uses the clean URL for the same resource.
  await svc.capture({ url: 'https://example.com/a', title: 'A', text: 'hello again' })

  // Second capture must have replaced the first (same pageId).
  // Only the second capture's chunks are pending.
  const pending = await store.pendingChunks(100)
  expect(pending.length).toBe(1)
  expect(pending[0].text).toBe('hello again')
})

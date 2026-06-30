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

  // Second capture: 1 paragraph -> 1 chunk. force:true = explicit re-capture (manual Update),
  // which is the path that is allowed to overwrite an already-saved page.
  const result2 = await svc.capture({ url: 'http://x/a', title: 'A', text: 'only one para', force: true })

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
  // Second capture uses the clean URL for the same resource. force:true = explicit re-capture
  // (manual Update), the only path allowed to overwrite an already-saved page.
  await svc.capture({ url: 'https://example.com/a', title: 'A', text: 'hello again', force: true })

  // Second capture must have replaced the first (same pageId).
  // Only the second capture's chunks are pending.
  const pending = await store.pendingChunks(100)
  expect(pending.length).toBe(1)
  expect(pending[0].text).toBe('hello again')
})

// Scenario: a user re-opens an article they already saved. The auto path (dwell/engagement,
// force=false) must NOT re-embed it - silent revisits should not rewrite a saved page's
// chunks (which also avoids the in-flight-embed wipe race).
// Coverage: integration (real chunker + real MemoryVectorStore.hasPage).
test('auto (force=false) on an already-saved page is skipped - chunks NOT rewritten', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), store)

  // First visit captures (page not yet saved).
  const first = await svc.capture({ url: 'http://x/a', title: 'A', text: 'first saved body' })
  expect(first.skipped).toBeUndefined()
  expect(first.chunkCount).toBeGreaterThan(0)

  // Revisit on the auto path: page is already saved -> skip, do not rewrite chunks.
  const second = await svc.capture({ url: 'http://x/a', title: 'A', text: 'second different body', force: false })
  expect(second.skipped).toBe('already-saved')
  expect(second.chunkCount).toBe(0)

  // The original chunks must remain untouched (still the first body, still pending).
  const pending = await store.pendingChunks(100)
  expect(pending.length).toBe(1)
  expect(pending[0].text).toBe('first saved body')
})

// Scenario: a user clicks "Update this page" (manual, force=true) on a page they already
// saved. That explicit intent MUST re-capture - the new content replaces the old chunks.
// Coverage: integration (real chunker + real MemoryVectorStore.hasPage).
test('force=true on an already-saved page re-captures - chunks rewritten', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), store)

  await svc.capture({ url: 'http://x/a', title: 'A', text: 'first saved body' })

  const updated = await svc.capture({ url: 'http://x/a', title: 'A', text: 'updated body text', force: true })
  expect(updated.skipped).toBeUndefined()
  expect(updated.chunkCount).toBeGreaterThan(0)

  const pending = await store.pendingChunks(100)
  expect(pending.length).toBe(updated.chunkCount)
  expect(pending[0].text).toBe('updated body text')
})

// Scenario: the common auto-capture case - a brand-new page the user just dwelled on.
// force=false must still capture when the page is NOT already saved.
// Coverage: integration (real chunker + real MemoryVectorStore.hasPage).
test('auto (force=false) on a NOT-saved page captures normally', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), store)

  const result = await svc.capture({ url: 'http://x/a', title: 'A', text: 'brand new page body', force: false })
  expect(result.skipped).toBeUndefined()
  expect(result.chunkCount).toBeGreaterThan(0)
  expect(await store.hasPage('http://x/a')).toBe(true)
})

// Scenario: a Wikipedia-style page yields a clean prose chunk and a citation-list chunk;
// a minProseScore must drop the citation chunk at index time so it never pollutes search.
// Coverage: integration (real CaptureService + real ParagraphChunker + MemoryVectorStore).
// Exactly 8 words each so ParagraphChunker(8) - which treats the whole text as ONE word
// stream (newlines are just whitespace, never a flush) - emits one pure-prose chunk and one
// pure-citation chunk with no word mixing across the boundary.
const PROSE8 = 'bacteria are ubiquitous mostly free living single organisms'
// A real-shaped, digit-dense citation token run (page/volume numbers, DOIs) - proseScore
// drives the drop mostly off digit density, so a marker-only line is NOT enough.
const CITE8 = '10.1093 jxb eri197 56 417 1761 doi 12498710'

test('minProseScore drops citation-shaped chunks but keeps prose chunks', async () => {
  const store = new MemoryVectorStore()
  const capture = new CaptureService(new ParagraphChunker(8), store, 0.35)
  const res = await capture.capture({ url: 'http://x/a', title: 'A', text: `${PROSE8} ${CITE8}` })
  expect(res.chunkCount).toBe(1) // citation chunk dropped, prose chunk kept
})

// Scenario: a genuinely table/formula-heavy page where EVERY chunk is low-prose must stay
// findable - the filter is bypassed rather than storing zero chunks.
// Coverage: integration (real CaptureService + real ParagraphChunker + MemoryVectorStore).
test('minProseScore is bypassed when ALL chunks are below threshold (page stays findable)', async () => {
  const store = new MemoryVectorStore()
  const capture = new CaptureService(new ParagraphChunker(8), store, 0.35)
  const res = await capture.capture({ url: 'http://x/b', title: 'B', text: CITE8 })
  expect(res.chunkCount).toBeGreaterThan(0) // guard: do not store ZERO chunks
})

// Scenario: existing callers that pass no threshold must keep every chunk (no behavior change).
// Coverage: integration (real CaptureService + real ParagraphChunker + MemoryVectorStore).
test('default (no minProseScore) keeps every chunk (backward compatible)', async () => {
  const store = new MemoryVectorStore()
  const capture = new CaptureService(new ParagraphChunker(8), store) // no threshold arg
  const res = await capture.capture({ url: 'http://x/c', title: 'C', text: CITE8 })
  expect(res.chunkCount).toBeGreaterThan(0)
})

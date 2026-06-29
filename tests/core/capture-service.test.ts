import { CaptureService } from '../../src/core/capture-service'
import { ParagraphChunker } from '../../src/core/paragraph-chunker'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { EmbeddingPort } from '../../src/core/ports'

// Deterministic fake: distinct unit direction per word count, so cosine can rank.
function embedText(t: string): Float32Array {
  const n = t.split(/\s+/).length
  return new Float32Array([Math.cos(n), Math.sin(n)])
}
const fakeEmbedder: EmbeddingPort = {
  async embed(texts) {
    return texts.map(embedText)
  },
}

test('captures a page into stored, embedded chunks', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), fakeEmbedder, store)

  // With word-stream chunker, 'one two' + 'three four five' (5 words < 220) merge into 1 chunk.
  await svc.capture({ url: 'http://x/a', title: 'A', text: 'one two\n\nthree four five' })

  const results = await store.search(embedText('one two three four five'), 10)
  expect(results.length).toBe(1)
  expect(results[0].chunk.text).toBe('one two three four five')
  expect(results[0].page.url).toBe('http://x/a')
})

test('uses passage prefix kind for embedding', async () => {
  const store = new MemoryVectorStore()
  const kinds: string[] = []
  const spy: EmbeddingPort = {
    async embed(texts, kind) {
      kinds.push(kind)
      return texts.map(() => new Float32Array([1, 0]))
    },
  }
  const svc = new CaptureService(new ParagraphChunker(220), spy, store)
  await svc.capture({ url: 'http://x/a', title: 'A', text: 'hello world' })
  expect(kinds).toContain('passage')
})

test('re-capture of same URL leaves exactly the new chunk count (no stale chunks)', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), fakeEmbedder, store)

  // First capture: 3 paragraphs, 9 words total -> 1 chunk (word-stream merges them, 9 < 220).
  await svc.capture({
    url: 'http://x/a',
    title: 'A',
    text: 'para one\n\npara two\n\npara three',
  })

  // Second capture: 1 paragraph -> 1 chunk
  await svc.capture({
    url: 'http://x/a',
    title: 'A',
    text: 'only one para',
  })

  const results = await store.search(embedText('only one para'), 10)
  expect(results.length).toBe(1)
  expect(results[0].chunk.text).toBe('only one para')
})

// Scenario: embed throws during re-capture; the original chunks must survive untouched.
// Coverage: integration (fake embedder that fails on the second call).
test('failed re-capture embed preserves the original chunks in the store', async () => {
  const store = new MemoryVectorStore()

  let callCount = 0
  const flakyEmbedder: EmbeddingPort = {
    async embed(texts) {
      callCount++
      if (callCount === 1) return texts.map(embedText)
      throw new Error('embed failed on second call')
    },
  }

  const svc = new CaptureService(new ParagraphChunker(220), flakyEmbedder, store)

  // First capture succeeds: 3 paragraphs, 9 words -> 1 chunk (word-stream merges, 9 < 220).
  await svc.capture({
    url: 'http://x/b',
    title: 'B',
    text: 'para one\n\npara two\n\npara three',
  })

  // Second capture: embed fails -> store must NOT be mutated.
  await expect(
    svc.capture({ url: 'http://x/b', title: 'B', text: 'new content here' }),
  ).rejects.toThrow('embed failed on second call')

  // The 1 original chunk is still searchable.
  const results = await store.search(embedText('para one'), 10)
  expect(results.length).toBe(1)
})

// Scenario: Credentials in a URL must not create a duplicate entry vs the clean URL.
// Coverage: integration (fake embedder; asserts single page via search result count).
test('URLs differing only in credentials map to the same stored page', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), fakeEmbedder, store)

  // First capture uses a URL with embedded credentials.
  await svc.capture({ url: 'https://user:pass@example.com/a', title: 'A', text: 'hello world' })
  // Second capture uses the clean URL for the same resource.
  await svc.capture({ url: 'https://example.com/a', title: 'A', text: 'hello again' })

  // Second capture must have overwritten the first (same pageId).
  // So exactly 1 chunk remains, belonging to the clean URL page.
  const results = await store.search(embedText('hello again'), 10)
  expect(results.length).toBe(1)
  expect(results[0].chunk.text).toBe('hello again')
})

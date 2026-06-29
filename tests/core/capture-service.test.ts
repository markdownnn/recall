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

  await svc.capture({ url: 'http://x/a', title: 'A', text: 'one two\n\nthree four five' })

  const results = await store.search(embedText('three four five'), 10)
  expect(results.length).toBe(2)
  expect(results[0].chunk.text).toBe('three four five')
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

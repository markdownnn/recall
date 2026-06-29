import { RecallService } from '../../src/core/recall-service'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { EmbeddingPort } from '../../src/core/ports'
import type { CapturedPage, Chunk } from '../../src/core/model'

const fakeEmbedder: EmbeddingPort = {
  async embed(texts) {
    return texts.map((t) => new Float32Array([t.includes('sleep') ? 1 : 0, 1]))
  },
}

async function seed(store: MemoryVectorStore) {
  const page: CapturedPage = { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 }
  await store.upsertPage(page)
  const sleepChunk: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'cortisol disrupts sleep' }
  const taxChunk: Chunk = { id: 'p1#1', pageId: 'p1', index: 1, text: 'tax basics' }
  await store.putChunks('p1', [sleepChunk, taxChunk])
  await store.setVector('p1#0', new Float32Array([1, 1]))
  await store.setVector('p1#1', new Float32Array([0, 1]))
}

test('returns the semantically closest chunk first', async () => {
  const store = new MemoryVectorStore()
  await seed(store)
  const svc = new RecallService(fakeEmbedder, store)
  const results = await svc.recall({ text: 'what wrecks my sleep', k: 2 })
  expect(results[0].chunk.text).toBe('cortisol disrupts sleep')
})

test('uses query prefix kind', async () => {
  const store = new MemoryVectorStore()
  await seed(store)
  const kinds: string[] = []
  const spy: EmbeddingPort = {
    async embed(texts, kind) {
      kinds.push(kind)
      return texts.map(() => new Float32Array([1, 1]))
    },
  }
  const svc = new RecallService(spy, store)
  await svc.recall({ text: 'q', k: 1 })
  expect(kinds).toEqual(['query'])
})

import { RecallService } from '../../src/core/recall-service'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { EmbeddingPort } from '../../src/core/ports'
import type { CapturedPage, Chunk } from '../../src/core/model'

// Scenario: Recall must return a chunk that matches by EXACT TERM even when another
// chunk is a closer vector neighbor - proving the lexical side of hybrid search participates.
// Coverage: integration (MemoryVectorStore hybrid + RecallService, fake embedder).
test('lexical win: chunk with rare term surfaces even if not the closest vector neighbor', async () => {
  const store = new MemoryVectorStore()

  // Page A: contains the rare token 'zythofrix' but vector is far from query vector.
  const pageA: CapturedPage = { id: 'pA', url: 'http://a', title: 'A', capturedAt: 1 }
  const termChunk: Chunk = { id: 'pA#0', pageId: 'pA', index: 0, text: 'zythofrix herb remedy plants' }

  // Page B: no rare token, but vector is close to query vector (the decoy).
  const pageB: CapturedPage = { id: 'pB', url: 'http://b', title: 'B', capturedAt: 1 }
  const decoyChunk: Chunk = { id: 'pB#0', pageId: 'pB', index: 0, text: 'pharmaceutical drug treatment' }

  await store.upsertPage(pageA)
  await store.upsertPage(pageB)
  await store.putChunks('pA', [termChunk])
  await store.putChunks('pB', [decoyChunk])
  // termChunk vector is far from query [1, 0].
  await store.setVector('pA#0', new Float32Array([0, 1]))
  // decoyChunk vector is close to query [1, 0].
  await store.setVector('pB#0', new Float32Array([1, 0]))

  // Embedder always returns [1, 0] - so decoyChunk is the vector winner.
  const embedder: EmbeddingPort = {
    async embed(texts) {
      return texts.map(() => new Float32Array([1, 0]))
    },
  }

  const svc = new RecallService(embedder, store)
  const results = await svc.recall({ text: 'zythofrix medication', k: 2 })

  // The term-bearing chunk must rank first: lexical match for 'zythofrix' overcomes
  // the vector disadvantage (decoyChunk has no match, termChunk wins in RRF).
  expect(results[0].chunk.id).toBe('pA#0')
})

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

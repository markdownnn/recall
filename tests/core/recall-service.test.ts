import { RecallService } from '../../src/core/recall-service'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import type { EmbeddingPort, RerankPort, VectorSearchPort } from '../../src/core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../../src/core/model'
import { rankedResult } from './fixtures'

// Minimal VectorSearchPort whose search() is supplied per-test; every other method is a no-op.
// Lets a reranking test assert exactly what k the store was asked for without a full store.
function fakeSearchStore(search: VectorSearchPort['search']): VectorSearchPort {
  return {
    upsertPage: async () => undefined,
    putChunks: async () => undefined,
    setVector: async () => undefined,
    pendingChunks: async () => [],
    hasPage: async () => false,
    pagePending: async () => false,
    recentPages: async () => [],
    pagesWithVectors: async () => [],
    clearVectorsForPage: async () => undefined,
    deletePagesByHost: async () => undefined,
    search,
    searchForAnswer: async () => [],
  }
}

const anyEmbedder: EmbeddingPort = { async embed(texts) { return texts.map(() => new Float32Array([1, 0])) } }

// Scenario: 벡터+FTS 순위는 "대충 비슷한 것"까지만 잡는다. 리랭커가 붙으면, 넉넉한 후보를 먼저 뽑고
// 크로스인코더가 그 안에서 진짜 정답을 top-k로 끌어올려야 한다(A1). 후보를 k보다 넓게 뽑는 게 핵심 —
// 정답이 6~N위에 있어도 리랭커가 top-k로 구제할 수 있다.
// Coverage: ⚠️ mock - 실제 크로스인코더 모델은 무겁기 때문에 같은 계약의 fake reranker로 배선만 확인한다.
test('recall retrieves a wider candidate pool and returns the reranker top-k order', async () => {
  const pool = Array.from({ length: 30 }, (_, i) =>
    rankedResult(`p${i}#0`, `text ${i}`, { id: `p${i}`, url: `http://${i}`, title: `T${i}`, capturedAt: 1 }),
  )
  let searchedK = 0
  const store = fakeSearchStore(async (_v, _t, k) => {
    searchedK = k
    return pool.slice(0, k)
  })
  // Fake cross-encoder: reverse the candidate pool so the reordering is unmistakable.
  const reranker: RerankPort = {
    rerank: async (_q, cands, k) => [...cands].reverse().slice(0, k),
  }

  const svc = new RecallService(anyEmbedder, store, reranker, 25)
  const results = await svc.recall({ text: 'q', k: 5 })

  // Retrieved the wider pool (candidateK=25), not just k=5.
  expect(searchedK).toBe(25)
  // Reranker reversed the 25-item pool, so the top-5 are the pool's last five.
  expect(results.map((r) => r.chunk.id)).toEqual(['p24#0', 'p23#0', 'p22#0', 'p21#0', 'p20#0'])
})

// Scenario: 리랭커 모델이 이 기기에서 로드에 실패(WebGPU·WASM 둘 다)해 rerank가 throw해도, 검색이
// 통째로 죽으면 안 된다. 리랭킹은 best-effort — 실패하면 하이브리드 검색 순서 top-k로 조용히 폴백한다.
// Coverage: ⚠️ mock - 같은 계약의 fake reranker가 throw하게 만들어 폴백 배선만 확인한다.
test('recall falls back to the hybrid-search order when the reranker throws', async () => {
  const pool = Array.from({ length: 10 }, (_, i) =>
    rankedResult(`p${i}#0`, `text ${i}`, { id: `p${i}`, url: `http://${i}`, title: `T${i}`, capturedAt: 1 }),
  )
  const store = fakeSearchStore(async (_v, _t, k) => pool.slice(0, k))
  const reranker: RerankPort = {
    rerank: async () => {
      throw new Error('reranker model unavailable on this device')
    },
  }

  const svc = new RecallService(anyEmbedder, store, reranker, 25)
  const results = await svc.recall({ text: 'q', k: 3 })

  // Fell back to the raw hybrid order (first 3 of the retrieved pool), not an error.
  expect(results.map((r) => r.chunk.id)).toEqual(['p0#0', 'p1#0', 'p2#0'])
})

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

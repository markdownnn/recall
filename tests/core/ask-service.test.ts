import { AskService } from '../../src/core/ask-service'
import type { AnswerGeneratorPort } from '../../src/core/answer-generator'
import type { EmbeddingPort, VectorSearchPort } from '../../src/core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../../src/core/model'

const page: CapturedPage = { id: 'p1', url: 'https://example.com/sleep', title: 'Sleep', capturedAt: 1 }
const chunk = (id: string, text: string): RankedResult => ({
  chunk: { id, pageId: 'p1', index: Number(id.split('#')[1]), text } as Chunk,
  page,
  score: 1,
})

function fakeStore(search: VectorSearchPort['search']): VectorSearchPort {
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
  }
}

const embedder: EmbeddingPort = {
  embed: async () => [new Float32Array([1, 0])],
}

// Scenario: Ask가 너무 적은 Chunk만 보면 답변 모델이 근거 없는 말을 만들 수 있다.
// Coverage: ⚠️ mock - 임베더, 저장소, 답변 생성기는 무거운 실제 부품 대신 같은 계약의 fake를 쓴다.
test('ask retrieves more chunks than search and sends a bounded context to generator', async () => {
  const results = Array.from({ length: 12 }, (_, i) => chunk(`p1#${i}`, `context ${i}`))
  let searchedK = 0
  let embeddedKind = ''
  let seenQuestion = ''
  const spyEmbedder: EmbeddingPort = {
    embed: async (_texts, kind) => {
      embeddedKind = kind
      return [new Float32Array([1, 0])]
    },
  }
  const store = fakeStore(async (_vector, _text, k) => {
    searchedK = k
    return results.slice(0, k)
  })
  let seen: string[] = []
  const generator: AnswerGeneratorPort = {
    answer: async ({ question, chunks }) => {
      seenQuestion = question
      seen = chunks.map((c) => c.chunk.text)
      return { text: 'Cortisol can hurt sleep.', citedChunkIds: chunks.slice(0, 3).map((c) => c.chunk.id) }
    },
  }

  const svc = new AskService(spyEmbedder, store, generator)
  const answer = await svc.ask({ text: 'what wrecks sleep?', retrieveK: 12, contextK: 8 })

  expect(embeddedKind).toBe('query')
  expect(searchedK).toBe(12)
  expect(seenQuestion).toBe('what wrecks sleep?')
  expect(seen).toHaveLength(8)
  expect(answer.sources).toHaveLength(3)
})

// Scenario: 저장된 근거가 없는데 답을 지어내면 Recall의 신뢰가 깨진다.
// Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 계약을 가진 fake generator를 쓴다.
test('ask returns not-found answer when retrieval has no chunks', async () => {
  const store = fakeStore(async () => [])
  const generator: AnswerGeneratorPort = {
    answer: async () => ({ text: 'should not be called', citedChunkIds: [] }),
  }

  const svc = new AskService(embedder, store, generator)
  const answer = await svc.ask({ text: 'unknown thing', retrieveK: 12, contextK: 8 })

  expect(answer.text).toBe('I could not find that in your saved pages.')
  expect(answer.sources).toEqual([])
})

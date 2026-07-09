import { expect, test, vi } from 'vitest'
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
    searchForAnswer: async (vector, text, options) => search(vector, text, options.maxContextChunks),
  }
}

const embedder: EmbeddingPort = {
  embed: async (texts) => texts.map((_, i) => new Float32Array([1, i])),
}

// Scenario: Ask가 너무 적은 Chunk만 보면 답변 모델이 근거 없는 말을 만들 수 있다. 하지만 같은 문서의 청크 여러 개를 썼다고 출처 링크가 여러 번 보이면 화면이 중복된다.
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
  expect(searchedK).toBe(8)
  expect(seenQuestion).toBe('what wrecks sleep?')
  expect(seen).toHaveLength(8)
  expect(answer.sources).toHaveLength(1)
  expect(answer.sources[0].page.id).toBe('p1')
})

// Scenario: 한 답변이 같은 저장 문서의 여러 청크를 근거로 삼아도 사용자는 문서 출처 하나만 보면 된다.
// Coverage: ⚠️ mock - 실제 검색/LLM은 무겁기 때문에 같은 계약의 fake로 출처 병합만 확인한다.
test('ask deduplicates answer sources by saved page', async () => {
  const results = Array.from({ length: 4 }, (_, i) => chunk(`p1#${i}`, `gaba context ${i}`))
  const store = fakeStore(async (_vector, _text, k) => results.slice(0, k))
  const generator: AnswerGeneratorPort = {
    answer: async ({ chunks }) => ({
      text: 'GABA is an inhibitory neurotransmitter.',
      citedChunkIds: chunks.slice(0, 3).map((c) => c.chunk.id),
    }),
  }

  const svc = new AskService(embedder, store, generator)
  const answer = await svc.ask({ text: 'what is GABA', retrieveK: 12, contextK: 8 })

  expect(answer.sources.map((source) => source.page.title)).toEqual(['Sleep'])
})

// Scenario: Ask 스트리밍은 글자를 먼저 보여주되, 끝난 뒤 출처는 기존 Ask처럼 문서 단위로 하나만 보여줘야 한다.
// Coverage: ⚠️ mock - 임베더, 저장소, 답변 생성기는 같은 계약의 fake로 두고 스트리밍 흐름만 확인한다.
test('askStream emits answer deltas and returns deduplicated sources', async () => {
  const results = Array.from({ length: 4 }, (_, i) => chunk(`p1#${i}`, `gaba context ${i}`))
  const store = fakeStore(async (_vector, _text, k) => results.slice(0, k))
  const generator: AnswerGeneratorPort = {
    answer: async () => ({ text: 'should not use non-stream answer', citedChunkIds: [] }),
    answerStream: async (_request, onDelta) => {
      onDelta('GABA is ')
      onDelta('inhibitory.')
      return {
        text: 'GABA is inhibitory.',
        citedChunkIds: results.slice(0, 3).map((r) => r.chunk.id),
      }
    },
  }

  const svc = new AskService(embedder, store, generator)
  const deltas: string[] = []
  const answer = await svc.askStream(
    { text: 'what is GABA', retrieveK: 12, contextK: 8 },
    (delta) => deltas.push(delta),
  )

  expect(deltas).toEqual(['GABA is ', 'inhibitory.'])
  expect(answer.text).toBe('GABA is inhibitory.')
  expect(answer.sources).toHaveLength(1)
})

// Scenario: Search UI는 page당 대표 청크가 좋지만 Ask는 답변 재료라서 같은 글의 여러 청크가 필요하다.
// Coverage: ⚠️ mock - 저장소는 같은 계약을 가진 fake로 두고 AskService가 전용 검색 옵션을 넘기는지 본다.
test('ask uses answer retrieval options instead of page-result search', async () => {
  const results = Array.from({ length: 4 }, (_, i) => chunk(`p1#${i}`, `cloudflare r2 context ${i}`))
  let normalSearchCalled = false
  let seenOptions: unknown
  const store: VectorSearchPort = {
    ...fakeStore(async () => {
      normalSearchCalled = true
      return []
    }),
    searchForAnswer: async (_vector, _text, options) => {
      seenOptions = options
      return results
    },
  }
  const generator: AnswerGeneratorPort = {
    answer: async ({ chunks }) => ({
      text: 'R2 is object storage. [p1#1]',
      citedChunkIds: [chunks[1].chunk.id],
    }),
  }

  const svc = new AskService(embedder, store, generator, {
    pageK: 2,
    hitsPerPage: 2,
    neighborWindow: 1,
    maxContextChunks: 6,
  })
  const answer = await svc.ask({ text: 'what is cloudflare r2?', retrieveK: 12, contextK: 8 })

  expect(normalSearchCalled).toBe(false)
  expect(seenOptions).toEqual({ pageK: 2, hitsPerPage: 2, neighborWindow: 1, maxContextChunks: 6 })
  expect(answer.text).toBe('R2 is object storage. [p1#1]')
})

// Scenario: 작은 로컬 모델은 원문 질문 하나만 검색하면 같은 뜻의 저장 글을 놓칠 수 있다.
// Coverage: ⚠️ mock - 실제 WebLLM과 벡터 DB는 무겁기 때문에 같은 계약의 fake로 쿼리 확장 흐름만 확인한다.
test('ask expands the question, searches each query, and merges duplicate chunks', async () => {
  const shared = chunk('p1#1', 'R2 is object storage.')
  const originalOnly = chunk('p1#0', 'Cloudflare has storage products.')
  const expandedOnly = chunk('p1#2', 'Buckets hold objects.')
  let embeddedTexts: string[] = []
  const searchedTexts: string[] = []
  let seenContextIds: string[] = []
  const spyEmbedder: EmbeddingPort = {
    embed: async (texts, kind) => {
      embeddedTexts = texts
      expect(kind).toBe('query')
      // Orthogonal one-hot vectors: each query gets a genuinely distinct direction (cosine 0
      // against every other), so semantic dedup never collapses these three unrelated queries.
      return texts.map((_, i) => {
        const vector = new Float32Array(texts.length)
        vector[i] = 1
        return vector
      })
    },
  }
  const store: VectorSearchPort = {
    ...fakeStore(async () => []),
    searchForAnswer: async (_vector, text) => {
      searchedTexts.push(text)
      if (text === 'what is cf r2?') return [{ ...originalOnly, score: 0.9 }, { ...shared, score: 0.7 }]
      if (text === 'cloudflare r2 object storage') return [{ ...shared, score: 0.95 }, { ...expandedOnly, score: 0.6 }]
      return []
    },
  }
  const generator: AnswerGeneratorPort = {
    expandQueries: async () => ['cloudflare r2 object storage', 'r2 buckets objects'],
    answer: async ({ chunks }) => {
      seenContextIds = chunks.map((r) => r.chunk.id)
      return { text: 'R2 is object storage.', citedChunkIds: chunks.map((r) => r.chunk.id) }
    },
  }

  const svc = new AskService(spyEmbedder, store, generator)
  const answer = await svc.ask({ text: 'what is cf r2?', retrieveK: 12, contextK: 8 })

  expect(embeddedTexts).toEqual(['what is cf r2?', 'cloudflare r2 object storage', 'r2 buckets objects'])
  expect(searchedTexts).toEqual(['what is cf r2?', 'cloudflare r2 object storage', 'r2 buckets objects'])
  expect(seenContextIds).toEqual(['p1#1', 'p1#0', 'p1#2'])
  expect(answer.sources).toHaveLength(1)
})

// Scenario: 확장 쿼리가 성공했는데 UI가 알 수 없으면 사용자는 어떤 검색을 같이 했는지 확인할 수 없다.
// Coverage: ⚠️ mock - Chrome 메시지 대신 AskService progress 콜백 계약으로 성공한 확장 쿼리 전달을 확인한다.
test('askStream reports expanded queries only when expansion succeeds', async () => {
  const result = chunk('p1#0', 'R2 is object storage.')
  const store = fakeStore(async () => [result])
  const generator: AnswerGeneratorPort = {
    expandQueries: async () => ['cloudflare r2 object storage'],
    answer: async () => ({ text: 'should not use non-stream answer', citedChunkIds: [] }),
    answerStream: async ({ chunks }) => ({
      text: 'R2 is object storage.',
      citedChunkIds: chunks.map((r) => r.chunk.id),
    }),
  }
  const events: Array<{ type: string; queries: string[] }> = []

  const svc = new AskService(embedder, store, generator)
  await svc.askStream(
    { text: 'what is cf r2?', retrieveK: 12, contextK: 8 },
    () => undefined,
    (event) => events.push(event),
  )

  expect(events).toEqual([{ type: 'expanded-queries', queries: ['what is cf r2?', 'cloudflare r2 object storage'] }])
})

// Scenario: 확장 쿼리 생성이 실패해도 Ask는 죽지 말고 원문 질문 검색만으로 계속 답해야 한다.
// Coverage: ⚠️ mock - 실제 WebLLM 오류 대신 같은 계약의 fake가 throw 하게 만든다.
test('ask falls back to the original question when query expansion fails', async () => {
  const result = chunk('p1#0', 'R2 is object storage.')
  let embeddedTexts: string[] = []
  const searchedTexts: string[] = []
  const spyEmbedder: EmbeddingPort = {
    embed: async (texts) => {
      embeddedTexts = texts
      return texts.map(() => new Float32Array([1, 0]))
    },
  }
  const store: VectorSearchPort = {
    ...fakeStore(async () => []),
    searchForAnswer: async (_vector, text) => {
      searchedTexts.push(text)
      return [result]
    },
  }
  const generator: AnswerGeneratorPort = {
    expandQueries: async () => {
      throw new Error('bad json')
    },
    answer: async ({ chunks }) => ({
      text: 'R2 is object storage.',
      citedChunkIds: chunks.map((r) => r.chunk.id),
    }),
  }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  try {
    const svc = new AskService(spyEmbedder, store, generator)
    const answer = await svc.ask({ text: 'what is cf r2?', retrieveK: 12, contextK: 8 })

    expect(embeddedTexts).toEqual(['what is cf r2?'])
    expect(searchedTexts).toEqual(['what is cf r2?'])
    expect(answer.text).toBe('R2 is object storage.')
    expect(warn).toHaveBeenCalledWith('[recall] query expansion failed:', expect.any(Error))
  } finally {
    warn.mockRestore()
  }
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

  expect(answer.text).toBe("I couldn't find that in your saved pages.")
  expect(answer.sources).toEqual([])
})

// Scenario: 검색 결과가 있어도 1등 점수가 너무 낮으면(관련 없는 근거), LLM을 호출해 그럴듯한 답을
// 지어내지 말고 바로 못 찾았다고 답해야 한다.
// Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 계약을 가진 fake generator를 쓴다.
test('ask returns not-found and skips the generator when the top score is below the confidence gate', async () => {
  const weak: RankedResult = { ...chunk('p1#0', 'barely related text'), score: 0.1 }
  const store = fakeStore(async () => [weak])
  let generatorCalled = false
  const generator: AnswerGeneratorPort = {
    answer: async () => {
      generatorCalled = true
      return { text: 'should not be called', citedChunkIds: [] }
    },
  }

  const svc = new AskService(embedder, store, generator)
  const answer = await svc.ask({ text: 'unrelated question', retrieveK: 12, contextK: 8 })

  expect(generatorCalled).toBe(false)
  expect(answer.text).toBe("I couldn't find that in your saved pages.")
  expect(answer.sources).toEqual([])
})

// Scenario: 확장 검색어 중 원본과 뜻이 겹치는 게 있으면(의미 유사도가 높으면) 실제로 검색에서
// 제외돼야 한다 — LLM이 다양화 지시를 안 따르고 동의어만 바꿔도 검색 낭비가 없어야 한다.
// Coverage: ⚠️ mock - 임베딩 벡터는 테스트가 직접 준 합성 값이라, "중복 제거가 배선대로 불리는가"만
// 확인한다. 실제 임베딩으로 진짜 다양화 효과가 나는지는 eval/run-ask.mjs 하네스의 몫.
test('ask drops an expanded query that is semantically too similar to one already kept', async () => {
  const result = chunk('p1#0', 'R2 is object storage.')
  const searchedTexts: string[] = []
  const spyEmbedder: EmbeddingPort = {
    embed: async (texts) => {
      // First two texts collapse to nearly the same vector (paraphrase), the third is distinct.
      return texts.map((_, i) => (i < 2 ? new Float32Array([1, 0]) : new Float32Array([0, 1])))
    },
  }
  const store: VectorSearchPort = {
    ...fakeStore(async () => []),
    searchForAnswer: async (_vector, text) => {
      searchedTexts.push(text)
      return [result]
    },
  }
  const generator: AnswerGeneratorPort = {
    expandQueries: async () => ['who invented rnn (paraphrase)', 'lstm inventors'],
    answer: async ({ chunks }) => ({
      text: 'R2 is object storage.',
      citedChunkIds: chunks.map((r) => r.chunk.id),
    }),
  }

  const svc = new AskService(spyEmbedder, store, generator)
  await svc.ask({ text: 'who invented rnn', retrieveK: 12, contextK: 8 })

  expect(searchedTexts).toEqual(['who invented rnn', 'lstm inventors'])
})

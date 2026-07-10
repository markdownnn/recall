// Every other Ask test wires ONE real class against a fake stand-in for the other:
// tests/core/ask-service.test.ts uses a real AskService with a fully-fake AnswerGeneratorPort,
// and tests/core/webllm-answer-generator.test.ts uses a real WebLlmAnswerGenerator with a fake
// chat engine. Neither proves the two REAL classes actually fit together -- that AskService's
// `chunks` really match what WebLlmAnswerGenerator's prompt shows the model, that
// parseAnswerCitation's output really flows back into AskService's source-matching, that
// resolveSearchQueries really drives WebLlmAnswerGenerator.expandQueries(). This file wires
// the real AskService to a real WebLlmAnswerGenerator, faking only the one thing that can't
// run outside a browser: the underlying WebLLM chat engine.
import { expect, test } from 'vitest'
import { AskService } from '../../src/core/ask-service'
import { WebLlmAnswerGenerator } from '../../src/offscreen/webllm-answer-generator'
import type { EmbeddingPort, VectorSearchPort } from '../../src/core/ports'
import type { RankedResult } from '../../src/core/model'
import { rankedResult as chunk } from './fixtures'

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

// A minimal fake of the WebLLM chat engine, keyed by WHICH pass is asking (expansion /
// evidence / final answer), distinguished by the request's shape -- the same way the real
// WebLLM engine is called by WebLlmAnswerGenerator, just without a real model underneath.
function fakeEngine(opts: {
  finalAnswer: string
  expandedQueries?: string[]
  onCall?: (kind: 'expand' | 'evidence' | 'answer', request: { max_tokens?: number; temperature?: number }) => void
}) {
  return {
    chat: {
      completions: {
        create: async (request: { max_tokens?: number; temperature?: number; stream?: boolean }) => {
          const kind: 'expand' | 'evidence' | 'answer' =
            request.temperature === 0.7 ? 'expand' : request.max_tokens === 220 ? 'evidence' : 'answer'
          opts.onCall?.(kind, request)
          if (kind === 'expand') {
            return { choices: [{ message: { content: JSON.stringify(opts.expandedQueries ?? []) } }] }
          }
          if (kind === 'evidence') {
            return { choices: [{ message: { content: 'evidence notes' } }] }
          }
          return { choices: [{ message: { content: opts.finalAnswer } }] }
        },
      },
    },
  }
}

// Scenario: 검색된 여러 청크 중 모델이 실제로 인용한 것만 출처가 되는지, AskService와
// WebLlmAnswerGenerator를 진짜로 이어붙였을 때도 성립하는지 확인한다 -- 각자 fake 상대방과
// 맞춰본 단위테스트는 이 연결 자체를 증명하지 못한다.
// Coverage: ⚠️ mock - WebLLM 채팅 엔진 자체(브라우저 GPU 전용)만 fake로 두고, AskService와
// WebLlmAnswerGenerator는 둘 다 실제 클래스를 그대로 쓴다.
test('ask wires real AskService to real WebLlmAnswerGenerator and derives sources from the actual citation tag', async () => {
  const chunks: RankedResult[] = [
    chunk('p1#0', 'Cortisol can disrupt REM sleep.'),
    chunk('p2#0', 'Caffeine blocks adenosine receptors.', { id: 'p2', url: 'https://example.com/caffeine', title: 'Caffeine', capturedAt: 1 }),
  ]
  const store = fakeStore(async () => chunks)
  const engine = fakeEngine({ finalAnswer: 'Cortisol disrupts sleep.\n[[cite: 1]]' })
  const generator = new WebLlmAnswerGenerator(engine as any)

  const svc = new AskService(embedder, store, generator)
  const answer = await svc.ask({ text: 'what hurts sleep?', retrieveK: 12, contextK: 8 })

  expect(answer.text).toBe('Cortisol disrupts sleep.')
  expect(answer.sources).toHaveLength(1)
  expect(answer.sources[0].page.id).toBe('p1')
})

// Scenario: 스트리밍 경로도 실제 두 클래스를 이어붙였을 때 델타가 흘러나오고, 최종 출처가 태그
// 기반으로 정확히 붙는지 확인한다.
// Coverage: ⚠️ mock - WebLLM 채팅 엔진만 fake, 나머지는 실제 클래스.
test('askStream wires real AskService to real WebLlmAnswerGenerator end to end', async () => {
  const chunks: RankedResult[] = [chunk('p1#0', 'Cortisol can disrupt REM sleep.')]
  const store = fakeStore(async () => chunks)
  const engine = {
    chat: {
      completions: {
        create: async (request: { max_tokens?: number; stream?: boolean }) => {
          if (request.stream) {
            return (async function* () {
              yield { choices: [{ delta: { content: 'Cortisol disrupts sleep.' } }] }
              yield { choices: [{ delta: { content: '\n[[cite: 1]]' } }] }
            })()
          }
          return { choices: [{ message: { content: 'evidence notes' } }] }
        },
      },
    },
  }
  const generator = new WebLlmAnswerGenerator(engine as any)

  const svc = new AskService(embedder, store, generator)
  const deltas: string[] = []
  const answer = await svc.askStream(
    { text: 'what hurts sleep?', retrieveK: 12, contextK: 8 },
    (delta) => deltas.push(delta),
  )

  expect(deltas.join('')).toContain('Cortisol disrupts sleep.')
  expect(answer.text).toBe('Cortisol disrupts sleep.')
  expect(answer.sources).toHaveLength(1)
})

// Scenario: AskService의 확장 검색어 로직(resolveSearchQueries)이 실제 WebLlmAnswerGenerator의
// expandQueries()를 정말로 호출하고, 그 결과를 검색에 반영하는지 확인한다.
// Coverage: ⚠️ mock - WebLLM 채팅 엔진만 fake, 확장 프롬프트 파싱은 실제 로직을 그대로 탄다.
test('ask drives query expansion through the real WebLlmAnswerGenerator.expandQueries', async () => {
  const chunks: RankedResult[] = [chunk('p1#0', 'R2 is object storage.')]
  const searchedTexts: string[] = []
  const store: VectorSearchPort = {
    ...fakeStore(async () => []),
    searchForAnswer: async (_vector, text) => {
      searchedTexts.push(text)
      return chunks
    },
  }
  // Mutually orthogonal vectors so none of the three collide under dedupeSimilarQueries --
  // this test is about expansion wiring, not dedup (that has its own coverage elsewhere).
  const orthogonalEmbedder: EmbeddingPort = {
    embed: async (texts) =>
      texts.map((text) => {
        if (text === 'what is cf r2?') return new Float32Array([1, 0, 0])
        if (text === 'cloudflare r2 pricing') return new Float32Array([0, 1, 0])
        return new Float32Array([0, 0, 1])
      }),
  }
  const engine = fakeEngine({
    finalAnswer: 'R2 is object storage.\n[[cite: 1]]',
    expandedQueries: ['cloudflare r2 pricing', 'r2 vs s3 api compatibility'],
  })
  const generator = new WebLlmAnswerGenerator(engine as any)

  const svc = new AskService(orthogonalEmbedder, store, generator)
  await svc.ask({ text: 'what is cf r2?', retrieveK: 12, contextK: 8 })

  expect(searchedTexts).toEqual(['what is cf r2?', 'cloudflare r2 pricing', 'r2 vs s3 api compatibility'])
})

// Scenario: 검색 결과 점수가 낮으면, 실제로 연결된 WebLlmAnswerGenerator의 "근거 노트"·"최종 답변"
// 호출은 절대 일어나지 않아야 한다 -- fake generator로 한 기존 테스트는 "게이트가 막는다"는 것만
// 증명했지, 실제 채팅 엔진 호출까지 진짜로 생략되는지는 증명하지 못했다. (확장 검색어 생성은 검색·
// 게이트 판정보다 앞서 일어나는 게 정상이라 이건 막지 않는다 -- 그래야 확장된 검색어로 검색해서
// 게이트를 통과할 기회를 준다.)
// Coverage: ⚠️ mock - WebLLM 채팅 엔진만 fake, 나머지는 실제 클래스.
test('ask skips the real WebLlmAnswerGenerator\'s evidence/answer calls when the confidence gate blocks', async () => {
  const weak: RankedResult = { ...chunk('p1#0', 'barely related text'), score: 0.1 }
  const store = fakeStore(async () => [weak])
  const calledKinds: string[] = []
  const engine = fakeEngine({
    finalAnswer: 'should not be reached',
    onCall: (kind) => { calledKinds.push(kind) },
  })
  const generator = new WebLlmAnswerGenerator(engine as any)

  const svc = new AskService(embedder, store, generator)
  const answer = await svc.ask({ text: 'unrelated question', retrieveK: 12, contextK: 8 })

  expect(calledKinds).not.toContain('evidence')
  expect(calledKinds).not.toContain('answer')
  expect(answer.text).toBe("I couldn't find that in your saved pages.")
})

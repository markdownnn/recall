import { describe, expect, test } from 'vitest'
import {
  buildAskMessages,
  buildEvidenceMessages,
  buildQueryExpansionMessages,
  MAX_ASK_PROMPT_CHUNKS,
  MAX_CHARS_PER_PROMPT_CHUNK,
  MAX_EVIDENCE_PROMPT_CHUNKS,
  buildLlamaAppConfig,
  buildGemmaAppConfig,
  LLAMA_ASK_MODEL,
  LLAMA_ASK_MODEL_DIR,
  LLAMA_ASK_MODEL_LIB,
  GEMMA_ASK_MODEL,
  GEMMA_ASK_MODEL_DIR,
  GEMMA_ASK_MODEL_LIB,
  GEMMA_ASK_SPEC,
  parseExpandedQueries,
  webLlmProgressToModelProgress,
  WebLlmAnswerGenerator,
} from '../../src/offscreen/webllm-answer-generator'
import type { RankedResult } from '../../src/core/model'
import { rankedResult } from './fixtures'

const result = rankedResult('p1#0', 'Cortisol can disrupt REM sleep.')
const CAFFEINE_PAGE = { id: 'p2', url: 'https://example.com/caffeine', title: 'Caffeine article', capturedAt: 1 }
const LIGHT_PAGE = { id: 'p3', url: 'https://example.com/light', title: 'Light article', capturedAt: 1 }

describe('webllm answer generator', () => {
  // Scenario: 인용 태그가 청크를 정확히 가리키려면 프롬프트에서 발췌마다 번호가 보여야 한다.
  // Coverage: ✅ integration
  test('ask prompt numbers each excerpt so the model can cite by number', () => {
    const second = rankedResult('p2#0', 'Caffeine blocks adenosine receptors.', CAFFEINE_PAGE)
    const messages = buildAskMessages('what hurts sleep?', [result, second])
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain('Excerpt 1)')
    expect(joined).toContain('Excerpt 2)')
  })

  // Scenario: 인용 태그 지시가 1B에서 "Excerpt Numbers Used" 섹션으로 새어 답을 지저분하게 만들었다.
  // 이제 프롬프트는 인용 태그를 요구하지 않고 헤더/라벨을 금지한다(출처는 컨텍스트 청크로 따로 표시).
  // Coverage: ✅ integration
  test('ask prompt does not ask for a citation tag and forbids headings/labels', () => {
    const messages = buildAskMessages('what hurts sleep?', [result])
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).not.toContain('[[cite:')
    expect(joined).not.toContain('Excerpt Numbers Used')
    expect(joined).toContain('no headings, labels, or section titles')
  })

  // Scenario: WebLLM이 저장된 근거 밖의 답을 만들거나 검색 결과를 나열하면 Recall Ask의 신뢰가 깨진다.
  // Coverage: ✅ integration
  test('ask prompt tells model to answer only from chunks', () => {
    const messages = buildAskMessages('what hurts sleep?', [result])
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain("You are Recall, a search assistant for the user's saved pages.")
    expect(joined).toContain('Answer the user\'s question using only the saved page excerpts below.')
    expect(joined).toContain('Use ONLY information found in the saved excerpts.')
    expect(joined).toContain('Never invent facts, numbers, names, or dates.')
    expect(joined).toContain('I couldn\'t find that in your saved pages.')
    expect(joined).toContain('SHORT, direct answer in 1-3 sentences')
    expect(joined).toContain('Do NOT quote, paste, or list the excerpts')
    expect(joined).toContain('no headings, labels, or section titles')
    expect(joined).toContain("Match the language of the user's question.")
    expect(joined).toContain('No opinions or filler.')
    expect(joined).toContain('Saved excerpts:')
    expect(joined).toContain('Cortisol can disrupt REM sleep.')
    expect(joined).not.toContain('Sources:')
    expect(joined).not.toContain('Source id:')
  })

  // Scenario: 작은 WebLLM이 검색 결과 읽기와 답변 작성을 한 번에 하면 관련 없는 내용을 섞기 쉽다.
  // Coverage: ✅ integration
  test('evidence prompt asks for short working notes without hidden thinking tags', () => {
    const messages = buildEvidenceMessages('what is GABA?', [result])
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain('Read the saved excerpts and the user question.')
    expect(joined).toContain('Return short working notes for the final answer.')
    expect(joined).toContain('Do not answer the user yet.')
    expect(joined).toContain('Saved excerpts:')
    expect(joined).toContain('Cortisol can disrupt REM sleep.')
    expect(joined).not.toContain('<thinking>')
    expect(joined).not.toContain('<answer>')
  })

  // Scenario: Ask가 검색 청크를 너무 많이, 너무 길게 그대로 넣으면 4K context window를 넘겨서 아예 답을 못 한다.
  // Coverage: ✅ integration
  test('prompt builders cap chunk count and chunk text length before calling WebLLM', () => {
    const oversized = Array.from({ length: 10 }, (_, i) => ({
      chunk: {
        id: `p1#${i}`,
        pageId: 'p1',
        index: i,
        text: `chunk ${i} ` + 'x'.repeat(MAX_CHARS_PER_PROMPT_CHUNK + 200),
      },
      page: { id: 'p1', url: 'https://example.com/long', title: 'Long page', capturedAt: 1 },
      score: 1,
    })) satisfies RankedResult[]

    const evidenceJoined = buildEvidenceMessages('what is this?', oversized).map((m) => m.content).join('\n')
    const answerJoined = buildAskMessages('what is this?', oversized).map((m) => m.content).join('\n')

    expect(evidenceJoined.match(/Page title: Long page/g)?.length).toBe(MAX_EVIDENCE_PROMPT_CHUNKS)
    expect(answerJoined.match(/Page title: Long page/g)?.length).toBe(MAX_ASK_PROMPT_CHUNKS)
    expect(evidenceJoined).not.toContain('p1#4')
    expect(answerJoined).not.toContain('p1#5')
    expect(evidenceJoined).not.toContain('x'.repeat(MAX_CHARS_PER_PROMPT_CHUNK + 50))
    expect(answerJoined).not.toContain('x'.repeat(MAX_CHARS_PER_PROMPT_CHUNK + 50))
  })

  // Scenario: 확장 검색어가 원문과 뜻만 같은 동의어면 검색이 매번 같은 결과만 낸다. WebLLM이 서로 다른
  // 측면(인물/개념/하위질문)으로 쪼개야 실제로 다른 저장 글을 찾아낼 수 있다.
  // Coverage: ✅ integration
  test('query expansion prompt asks for distinct-angle search queries as JSON', () => {
    const messages = buildQueryExpansionMessages('what is cf r2?')
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain("You expand a user's search query into multiple search queries")
    expect(joined).toContain('each explore a DIFFERENT angle, entity, or sub-topic')
    expect(joined).toContain('Do NOT just reword the same idea with synonyms')
    expect(joined).toContain('Output ONLY a JSON array of strings.')
    expect(joined).toContain('No explanation, no markdown.')
    expect(joined).toContain('User question: what is cf r2?')
    expect(joined).not.toContain('<thinking>')
    expect(joined).not.toContain('<answer>')
  })

  // Scenario: 확장 쿼리 JSON에 빈 값이나 너무 많은 값이 섞이면 검색이 느려지고 시끄러워진다.
  // Coverage: ✅ integration
  test('parseExpandedQueries keeps only clean string queries with a small cap', () => {
    expect(parseExpandedQueries('["cloudflare r2 object storage","",7,"r2 buckets","s3 api","billing"]'))
      .toEqual(['cloudflare r2 object storage', 'r2 buckets', 's3 api', 'billing'])
    expect(parseExpandedQueries('not json')).toEqual([])
  })

  // Scenario: WebLLM이 만든 검색 변형이 AskService로 넘어가야 원문 질문 하나만 검색하는 한계를 줄일 수 있다.
  // Coverage: ⚠️ mock - 실제 WebLLM 대신 같은 chat 계약을 가진 fake engine을 쓴다.
  test('expandQueries returns parsed WebLLM query alternatives', async () => {
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: '["cloudflare r2 object storage","r2 buckets"]' } }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    await expect(generator.expandQueries('what is cf r2?'))
      .resolves.toEqual(['cloudflare r2 object storage', 'r2 buckets'])
  })

  // Scenario: WebLLM 기본 설정이 Hugging Face나 GitHub에서 모델을 받으면 R2 캐시를 못 쓴다.
  // Coverage: ✅ integration
  test('llama app config uses only model CDN urls', () => {
    const baseUrl = `https://cdn.teamnyongs.com/models/${LLAMA_ASK_MODEL_DIR}`
    const modelLibUrl = `${baseUrl}${LLAMA_ASK_MODEL_LIB}`
    const config = buildLlamaAppConfig(baseUrl, modelLibUrl)
    const record = config.model_list[0]
    const serialized = JSON.stringify(config)

    expect(record.model_id).toBe(LLAMA_ASK_MODEL)
    expect(record.model).toBe(baseUrl)
    expect(record.model_lib).toBe(modelLibUrl)
    expect(record.model).toBe(
      'https://cdn.teamnyongs.com/models/webllm/llama-3.2-1b-instruct/q4f16_1/resolve/main/',
    )
    expect(record.model).toContain('/resolve/main/')
    expect(serialized).not.toContain('huggingface.co')
    expect(serialized).not.toContain('raw.githubusercontent.com')
    expect(serialized).not.toContain('chrome-extension://')
  })

  // Scenario: 조립 지점(offscreen)이 모델을 spec 하나로 고르는 헥사고날 구조 — GEMMA_ASK_SPEC이 실제
  // Gemma 모델/디렉토리/라이브러리를 정확히 묶어야 엔진 팩토리가 올바른 CDN 경로로 로드한다.
  // Coverage: ✅ integration
  test('GEMMA_ASK_SPEC bundles the gemma model, dir, lib and app-config builder', () => {
    expect(GEMMA_ASK_SPEC.modelId).toBe(GEMMA_ASK_MODEL)
    expect(GEMMA_ASK_SPEC.modelDir).toBe(GEMMA_ASK_MODEL_DIR)
    expect(GEMMA_ASK_SPEC.modelLib).toBe(GEMMA_ASK_MODEL_LIB)
    expect(GEMMA_ASK_SPEC.buildAppConfig).toBe(buildGemmaAppConfig)
  })

  // Scenario: 라마 모델이 처음 켜질 때 오래 걸리는데 진행률이 없으면 사용자는 멈춘 줄 안다.
  // Coverage: ✅ integration
  test('webllm progress reports become model loading percentages', () => {
    expect(webLlmProgressToModelProgress({ progress: 0.42, text: 'loading', timeElapsed: 1 }))
      .toEqual({ status: 'progress', progress: 42 })
    expect(webLlmProgressToModelProgress({ progress: 42, text: 'loading', timeElapsed: 1 }))
      .toEqual({ status: 'progress', progress: 42 })
  })

  // Scenario: 모델이 [[cite: N]] 형식을 정확히 지키면, 답변 본문은 그대로 두고 태그 줄만 잘라내며
  // citedChunkIds는 태그가 가리킨 청크가 된다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 chat 계약을 가진 fake engine을 쓴다.
  test('answer keeps the model text as-is and only strips the trailing citation tag', async () => {
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'Cortisol can disrupt sleep.\n[[cite: 1]]' } }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(answer.text).toBe('Cortisol can disrupt sleep.')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })

  // Scenario: 모델이 인용 태그를 아예 안 달면, 상위 청크로 대신 채우지 말고 출처를 비워야 한다
  // (ADR 0024: 근거가 불확실하면 추측 대신 비운다).
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 태그 없는 chat 응답 계약만 fake로 둔다.
  test('answer returns no sources when the model omits the citation tag', async () => {
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'The saved page says cortisol can disrupt REM sleep.' } }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(answer.text).toBe('The saved page says cortisol can disrupt REM sleep.')
    expect(answer.citedChunkIds).toEqual([])
  })

  // Scenario: 예전엔 답변 전에 "근거 메모" 단계를 한 번 더 돌렸는데, 그 메모의 메타 문구("Excerpt 1
  // directly answers...")가 최종 답에 새어들어 제거했다. 이제 답변은 단 한 번의 호출로, 근거 메모 없이 만든다.
  // Coverage: ⚠️ mock - 실제 WebLLM 대신 같은 chat 계약을 가진 fake engine으로 호출 횟수와 프롬프트만 확인한다.
  test('answer makes a single answer call with no separate evidence pass', async () => {
    const calls: Array<{ content: string; maxTokens?: number }> = []
    const engine = {
      chat: {
        completions: {
          create: async (request: { messages: Array<{ content: string }>; max_tokens?: number }) => {
            calls.push({ content: request.messages.map((m) => m.content).join('\n'), maxTokens: request.max_tokens })
            return { choices: [{ message: { content: 'GABA is an inhibitory neurotransmitter.' } }] }
          },
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what is GABA?', chunks: [result] })

    expect(calls).toHaveLength(1) // no evidence pass
    expect(calls[0].content).not.toContain('Working notes:')
    expect(calls[0].content).not.toContain('Return short working notes')
    expect(calls[0].maxTokens).toBe(200)
    expect(answer.text).toBe('GABA is an inhibitory neurotransmitter.')
  })

  // Scenario: 답변은 한 번의 호출로 만들고, 끝에 붙은 숨김 인용 태그([[cite: 1]])는 화면 텍스트에서
  // 잘라내되 citedChunkIds로는 뽑아낸다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 chat 호출 횟수만 fake로 확인한다.
  test('answer strips the trailing citation tag and returns cited chunk ids in one call', async () => {
    let calls = 0
    const engine = {
      chat: {
        completions: {
          create: async () => {
            calls++
            return { choices: [{ message: { content: 'Sleep article says cortisol disrupts sleep.\n[[cite: 1]]' } }] }
          },
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(calls).toBe(1)
    expect(answer.text).toBe('Sleep article says cortisol disrupts sleep.')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })

  // Scenario: WebLLM 답변을 다 만든 뒤 한 번에 보여주면 사용자는 loading 상태에서 멈춘 것처럼 느낀다.
  // 인용 태그는 스트리밍 도중엔 그대로 흘러나오지만(마지막 조각이라 미리 알 방법이 없음), 최종
  // answer.text에서는 잘려나가야 한다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 stream chunk 계약을 가진 fake engine을 쓴다.
  test('answerStream emits deltas as WebLLM chunks arrive and strips the trailing citation tag from the final text', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'GABA is ' } }] }
      yield { choices: [{ delta: { content: 'an inhibitory neurotransmitter.' } }] }
      yield { choices: [{ delta: { content: '\n[[cite: 1]]' } }] }
      yield { choices: [{ delta: {} }] }
    }
    let sawStream = false
    const engine = {
      chat: {
        completions: {
          create: async (request: { stream?: boolean }) => {
            sawStream = request.stream === true
            return chunks()
          },
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const deltas: string[] = []
    const answer = await generator.answerStream(
      { question: 'what is GABA?', chunks: [result] },
      (delta) => deltas.push(delta),
    )

    expect(sawStream).toBe(true)
    expect(deltas).toEqual(['GABA is ', 'an inhibitory neurotransmitter.', '\n[[cite: 1]]'])
    expect(answer.text).toBe('GABA is an inhibitory neurotransmitter.')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })

  // Scenario: Ask는 짧게 요약한 결과를 내야 한다. 답변 토큰 예산을 일부러 작게(200) 잡아, 1B가 excerpt를
  // 계속 붙이다 문장 중간에 잘리는 대신 짧게 끝맺게 한다.
  // Coverage: ⚠️ mock - 실제 WebLLM 대신 요청 옵션만 기록하는 fake engine을 쓴다.
  test('answer and answerStream cap the answer at a concise token budget', async () => {
    const seen: number[] = []
    async function* chunks() {
      yield { choices: [{ delta: { content: 'GABA is inhibitory.' } }] }
    }
    const engine = {
      chat: {
        completions: {
          create: async (request: { max_tokens?: number; stream?: boolean }) => {
            seen.push(request.max_tokens ?? 0)
            if (request.stream) return chunks()
            return { choices: [{ message: { content: 'GABA is inhibitory.' } }] }
          },
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    await generator.answer({ question: 'what is GABA?', chunks: [result] })
    await generator.answerStream({ question: 'what is GABA?', chunks: [result] }, () => undefined)

    // One answer call each (no evidence pass), both capped at the concise 200-token budget.
    expect(seen).toEqual([200, 200])
  })

  // Scenario: 청크가 여러 개일 때, 모델이 실제로 인용한 발췌만 출처가 되고 인용 안 한 발췌는 빠져야
  // 한다. 청크 1개짜리 테스트로는 "태그를 읽는지"와 "무조건 상위 N개인지"를 구분 못 하므로, 이 구멍을
  // 청크 3개로 명시적으로 막는다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 chat 계약을 가진 fake engine을 쓴다.
  test('answer cites only the excerpts the model tagged, not every retrieved chunk', async () => {
    const chunks: RankedResult[] = [
      rankedResult('p1#0', 'Cortisol can disrupt REM sleep.'),
      rankedResult('p2#0', 'Caffeine blocks adenosine receptors.', CAFFEINE_PAGE),
      rankedResult('p3#0', 'Blue light suppresses melatonin.', LIGHT_PAGE),
    ]
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: { content: 'Cortisol and blue light both disrupt sleep.\n[[cite: 1, 3]]' },
            }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what disrupts sleep?', chunks })

    expect(answer.text).toBe('Cortisol and blue light both disrupt sleep.')
    expect(answer.citedChunkIds).toEqual(['p1#0', 'p3#0'])
  })

  // Scenario: AskService retrieves up to contextK (8 by default) chunks, but the prompt only
  // ever numbers and shows the model the first MAX_ASK_PROMPT_CHUNKS (5) of them. If the
  // model cites a number beyond 5 (an excerpt it was never shown), that citation must NOT
  // resolve to a real chunk just because the number happens to be within the full 8-item
  // array's bounds.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 chat 계약을 가진 fake engine을 쓴다.
  test('answer never resolves a citation number beyond what the prompt actually showed the model', async () => {
    const eightChunks: RankedResult[] = Array.from({ length: 8 }, (_, i) =>
      rankedResult(`p${i}#0`, `Excerpt number ${i + 1} content.`, {
        id: `p${i}`, url: `https://example.com/${i}`, title: `Page ${i}`, capturedAt: 1,
      }),
    )
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              // The model hallucinates citing excerpt 6, which is beyond MAX_ASK_PROMPT_CHUNKS (5)
              // and was never numbered/shown to it in the prompt.
              message: { content: 'This is an answer.\n[[cite: 6]]' },
            }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what does this say?', chunks: eightChunks })

    expect(answer.citedChunkIds).toEqual([])
  })

  // Scenario: 같은 5-vs-8 경계 버그가 스트리밍 경로(answerStream)에도 있었다 -- 위 테스트는 answer()만
  // 지킨다. 스트리밍 코드가 나중에 따로 리팩터링되면서 이 검증이 빠지는 걸 막기 위해 answerStream도
  // 똑같이 확인한다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 stream chunk 계약을 가진 fake engine을 쓴다.
  test('answerStream never resolves a citation number beyond what the prompt actually showed the model', async () => {
    const eightChunks: RankedResult[] = Array.from({ length: 8 }, (_, i) =>
      rankedResult(`p${i}#0`, `Excerpt number ${i + 1} content.`, {
        id: `p${i}`, url: `https://example.com/${i}`, title: `Page ${i}`, capturedAt: 1,
      }),
    )
    async function* chunks() {
      yield { choices: [{ delta: { content: 'This is an answer.\n[[cite: 6]]' } }] }
    }
    const engine = {
      chat: {
        completions: {
          create: async (request: { stream?: boolean }) => (request.stream ? chunks() : {
            choices: [{ message: { content: 'evidence notes' } }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answerStream(
      { question: 'what does this say?', chunks: eightChunks },
      () => undefined,
    )

    expect(answer.citedChunkIds).toEqual([])
  })
})

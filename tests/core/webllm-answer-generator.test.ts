import { describe, expect, test } from 'vitest'
import {
  buildAskMessages,
  buildEvidenceMessages,
  buildQueryExpansionMessages,
  MAX_ASK_PROMPT_CHUNKS,
  MAX_CHARS_PER_PROMPT_CHUNK,
  MAX_EVIDENCE_PROMPT_CHUNKS,
  buildLlamaAppConfig,
  LLAMA_ASK_MODEL,
  LLAMA_ASK_MODEL_DIR,
  LLAMA_ASK_MODEL_LIB,
  parseExpandedQueries,
  webLlmProgressToModelProgress,
  WebLlmAnswerGenerator,
} from '../../src/offscreen/webllm-answer-generator'
import type { RankedResult } from '../../src/core/model'

const result: RankedResult = {
  chunk: { id: 'p1#0', pageId: 'p1', index: 0, text: 'Cortisol can disrupt REM sleep.' },
  page: { id: 'p1', url: 'https://example.com/sleep', title: 'Sleep article', capturedAt: 1 },
  score: 1,
}

describe('webllm answer generator', () => {
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
    expect(joined).toContain("Synthesize across excerpts into one coherent answer.")
    expect(joined).toContain("Don't list excerpts one by one or copy snippets verbatim.")
    expect(joined).toContain('Lead with the direct answer first')
    expect(joined).toContain('Keep it to 2-3 short paragraphs.')
    expect(joined).toContain("Match the language of the user's question.")
    expect(joined).toContain("Don't add opinions or filler like \"Great question!\"")
    expect(joined).toContain('Saved excerpts:')
    expect(joined).toContain('Do not write audit sections like "what is provided", "what is missing", or "this saved chunk supports".')
    expect(joined).toContain('Cortisol can disrupt REM sleep.')
    expect(joined).not.toContain('say what is missing')
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

  // Scenario: 근거 메모를 만든 뒤 최종 답변에 넘겨야 답변 모델이 관련 근거를 더 잘 따라간다.
  // Coverage: ✅ integration
  test('answer prompt can include internal evidence notes without showing a notes section', () => {
    const messages = buildAskMessages('what is GABA?', [result], 'Direct fact: GABA is inhibitory.')
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain('Working notes:')
    expect(joined).toContain('Direct fact: GABA is inhibitory.')
    expect(joined).toContain('Do not mention the working notes.')
    expect(joined).not.toContain('Sources:')
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
    const answerJoined = buildAskMessages('what is this?', oversized, 'note').map((m) => m.content).join('\n')

    expect(evidenceJoined.match(/Page title: Long page/g)?.length).toBe(MAX_EVIDENCE_PROMPT_CHUNKS)
    expect(answerJoined.match(/Page title: Long page/g)?.length).toBe(MAX_ASK_PROMPT_CHUNKS)
    expect(evidenceJoined).not.toContain('p1#4')
    expect(answerJoined).not.toContain('p1#5')
    expect(evidenceJoined).not.toContain('x'.repeat(MAX_CHARS_PER_PROMPT_CHUNK + 50))
    expect(answerJoined).not.toContain('x'.repeat(MAX_CHARS_PER_PROMPT_CHUNK + 50))
  })

  // Scenario: 원문 질문과 저장 글의 단어가 다르면 검색이 놓칠 수 있으므로 WebLLM이 검색용 변형 문장을 만들어야 한다.
  // Coverage: ✅ integration
  test('query expansion prompt asks for JSON search queries only', () => {
    const messages = buildQueryExpansionMessages('what is cf r2?')
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain("You rewrite a user's search query into multiple search queries")
    expect(joined).toContain('output 3-4 alternative search queries')
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

  // Scenario: 라마 모델이 처음 켜질 때 오래 걸리는데 진행률이 없으면 사용자는 멈춘 줄 안다.
  // Coverage: ✅ integration
  test('webllm progress reports become model loading percentages', () => {
    expect(webLlmProgressToModelProgress({ progress: 0.42, text: 'loading', timeElapsed: 1 }))
      .toEqual({ status: 'progress', progress: 42 })
    expect(webLlmProgressToModelProgress({ progress: 42, text: 'loading', timeElapsed: 1 }))
      .toEqual({ status: 'progress', progress: 42 })
  })

  // Scenario: 모델 출력을 코드가 몰래 고치면 스트리밍과 디버깅이 모두 어려워진다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 chat 계약을 가진 fake engine을 쓴다.
  test('answer returns model text without parser cleanup', async () => {
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'Cortisol can disrupt sleep.\\nSources: [p1#0] [missing#9]' } }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(answer.text).toBe('Cortisol can disrupt sleep.\\nSources: [p1#0] [missing#9]')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })

  // Scenario: 출처는 답변 카드 하단에 이미 보이므로 WebLLM 답변 본문에 내부용 Sources 줄을 강요하지 않는다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 source 없는 chat 응답 계약만 fake로 둔다.
  test('answer can omit source lines and still uses retrieved chunks as sources', async () => {
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
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })

  // Scenario: evidence pass는 사용자에게 보일 답변이 아니라 다음 답변 호출에 들어갈 짧은 내부 메모다.
  // Coverage: ⚠️ mock - 실제 WebLLM 대신 같은 chat 계약을 가진 fake engine으로 호출 순서와 프롬프트 전달만 확인한다.
  test('answer runs an evidence pass before the final answer', async () => {
    const calls: Array<{ content: string; maxTokens?: number }> = []
    const engine = {
      chat: {
        completions: {
          create: async (request: { messages: Array<{ content: string }>; max_tokens?: number }) => {
            const content = request.messages.map((m) => m.content).join('\n')
            calls.push({ content, maxTokens: request.max_tokens })
            return {
              choices: [{
                message: {
                  content: calls.length === 1
                    ? 'Direct fact: GABA is inhibitory.'
                    : 'GABA is an inhibitory neurotransmitter.',
                },
              }],
            }
          },
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what is GABA?', chunks: [result] })

    expect(calls).toHaveLength(2)
    expect(calls[0].content).toContain('Return short working notes')
    expect(calls[0].maxTokens).toBe(220)
    expect(calls[1].content).toContain('Working notes:')
    expect(calls[1].content).toContain('Direct fact: GABA is inhibitory.')
    expect(calls[1].maxTokens).toBe(640)
    expect(answer.text).toBe('GABA is an inhibitory neurotransmitter.')
  })

  // Scenario: 스트리밍으로 가려면 첫 답을 숨겼다가 다시 쓰는 흐름이 화면을 복잡하게 만든다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 chat 호출 횟수만 fake로 확인한다.
  test('answer does not retry when the first draft looks like a raw source snippet', async () => {
    let calls = 0
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: calls++ === 0 ? 'Relevant fact: sleep article.' : '[p1#0] Sleep article',
              },
            }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(calls).toBe(2)
    expect(answer.text).toBe('[p1#0] Sleep article')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })

  // Scenario: WebLLM 답변을 다 만든 뒤 한 번에 보여주면 사용자는 loading 상태에서 멈춘 것처럼 느낀다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 stream chunk 계약을 가진 fake engine을 쓴다.
  test('answerStream emits deltas as WebLLM chunks arrive', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'GABA is ' } }] }
      yield { choices: [{ delta: { content: 'an inhibitory neurotransmitter.' } }] }
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
    expect(deltas).toEqual(['GABA is ', 'an inhibitory neurotransmitter.'])
    expect(answer.text).toBe('GABA is an inhibitory neurotransmitter.')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })

  // Scenario: saved page 답변이 길어질 때 출력 토큰 예산이 너무 작으면 문장이 중간에서 끊긴다.
  // Coverage: ⚠️ mock - 실제 WebLLM 대신 요청 옵션만 기록하는 fake engine을 쓴다.
  test('answer and answerStream use a larger answer token budget', async () => {
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

    expect(seen).toEqual([220, 640, 220, 640])
  })
})

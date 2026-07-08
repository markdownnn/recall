import { describe, expect, test } from 'vitest'
import { buildAskMessages, WebLlmAnswerGenerator } from '../../src/offscreen/webllm-answer-generator'
import type { RankedResult } from '../../src/core/model'

const result: RankedResult = {
  chunk: { id: 'p1#0', pageId: 'p1', index: 0, text: 'Cortisol can disrupt REM sleep.' },
  page: { id: 'p1', url: 'https://example.com/sleep', title: 'Sleep article', capturedAt: 1 },
  score: 1,
}

describe('webllm answer generator', () => {
  // Scenario: WebLLM이 저장된 근거 밖의 답을 만들면 Recall의 신뢰가 깨진다.
  // Coverage: ✅ integration
  test('ask prompt tells model to answer only from chunks', () => {
    const messages = buildAskMessages('what hurts sleep?', [result])
    const joined = messages.map((m) => m.content).join('\n')

    expect(joined).toContain('Use only the saved chunks')
    expect(joined).toContain('I could not find that in your saved pages.')
    expect(joined).toContain('[p1#0]')
    expect(joined).toContain('Cortisol can disrupt REM sleep.')
  })

  // Scenario: WebLLM이 없는 Chunk id를 인용하면 사용자에게 가짜 출처가 보일 수 있다.
  // Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 같은 chat 계약을 가진 fake engine을 쓴다.
  test('answer keeps only cited chunk ids that were provided', async () => {
    const engine = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'Cortisol can disrupt sleep. [p1#0] [missing#9]' } }],
          }),
        },
      },
    }

    const generator = new WebLlmAnswerGenerator(engine as any)
    const answer = await generator.answer({ question: 'what hurts sleep?', chunks: [result] })

    expect(answer.text).toBe('Cortisol can disrupt sleep. [p1#0] [missing#9]')
    expect(answer.citedChunkIds).toEqual(['p1#0'])
  })
})

import { describe, expect, test } from 'vitest'
import {
  ASK_MODEL_CANDIDATES,
  buildGemmaAppConfig,
  GEMMA_ASK_MODEL,
  GEMMA_ASK_MODEL_LIB,
  LLAMA_ASK_MODEL,
} from '../../src/offscreen/webllm-answer-generator'

describe('webllm ask model options', () => {
  // Scenario: 답변 모델 후보 순서가 바뀌면 라마로 먼저 시작한다는 제품 결정이 깨진다.
  // Coverage: ✅ integration
  test('ask model candidates are llama first then gemma', () => {
    expect(ASK_MODEL_CANDIDATES).toEqual([
      LLAMA_ASK_MODEL,
      GEMMA_ASK_MODEL,
    ])
  })

  // Scenario: Gemma 후보도 WebLLM 기본 외부 주소를 쓰면 확장 프로그램 CSP에 막힌다.
  // Coverage: ✅ integration
  test('gemma app config uses only self-hosted model urls', () => {
    const baseUrl = 'chrome-extension://recall/models/webllm/gemma3-1b-it/q4f16_1/resolve/main/'
    const modelLibUrl = `${baseUrl}${GEMMA_ASK_MODEL_LIB}`
    const config = buildGemmaAppConfig(baseUrl, modelLibUrl)
    const record = config.model_list[0]
    const serialized = JSON.stringify(config)

    expect(record.model_id).toBe(GEMMA_ASK_MODEL)
    expect(record.model).toBe(baseUrl)
    expect(record.model_lib).toBe(modelLibUrl)
    expect(record.overrides).toMatchObject({ context_window_size: 4096, sliding_window_size: -1 })
    expect(record.model).toContain('/resolve/main/')
    expect(serialized).not.toContain('huggingface.co')
    expect(serialized).not.toContain('raw.githubusercontent.com')
  })
})

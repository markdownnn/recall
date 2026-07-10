import { describe, expect, test } from 'vitest'
import {
  ASK_MODEL_CANDIDATES,
  buildGemmaAppConfig,
  GEMMA_ASK_MODEL,
  GEMMA_ASK_MODEL_DIR,
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

  // Scenario: Gemma 후보도 같은 CDN 규칙을 쓰지 않으면 나중에 모델 교체 때 다시 다운로드 경로가 깨진다.
  // Coverage: ✅ integration
  test('gemma app config uses only model CDN urls', () => {
    const baseUrl = `https://cdn.teamnyongs.com/models/${GEMMA_ASK_MODEL_DIR}`
    const modelLibUrl = `${baseUrl}${GEMMA_ASK_MODEL_LIB}`
    const config = buildGemmaAppConfig(baseUrl, modelLibUrl)
    const record = config.model_list[0]
    const serialized = JSON.stringify(config)

    expect(record.model_id).toBe(GEMMA_ASK_MODEL)
    expect(record.model).toBe(baseUrl)
    expect(record.model_lib).toBe(modelLibUrl)
    // Gemma 3 must use its native sliding-window attention: context_window_size -1 so the model's
    // own sliding_window_size (512) is the single positive one WebLLM requires. Forcing full
    // attention (sliding_window_size -1) broke inference into gibberish. Regression guard.
    expect(record.overrides).toMatchObject({ context_window_size: -1, attention_sink_size: 0 })
    expect(record.overrides).not.toHaveProperty('sliding_window_size')
    expect(record.model).toBe(
      'https://cdn.teamnyongs.com/models/webllm/gemma3-1b-it/q4f16_1/resolve/main/',
    )
    expect(record.model).toContain('/resolve/main/')
    expect(serialized).not.toContain('huggingface.co')
    expect(serialized).not.toContain('raw.githubusercontent.com')
    expect(serialized).not.toContain('chrome-extension://')
  })
})

import { describe, expect, test } from 'vitest'
import {
  INITIAL_ASK_MODEL_STATUS,
  reduceAskModelProgress,
  type AskModelStatus,
} from '../../src/core/ask-model-status'

describe('reduceAskModelProgress', () => {
  // Scenario: 사용자가 Download WebLLM을 눌렀을 때 Ask 버튼은 바로 켜지면 안 된다.
  // Coverage: ✅ integration
  test('initiate transitions to loading', () => {
    expect(reduceAskModelProgress(INITIAL_ASK_MODEL_STATUS, { status: 'initiate' }))
      .toEqual({ state: 'loading', percent: 0 })
  })

  // Scenario: 다운로드 진행률이 뒤로 가면 사용자는 로딩이 고장난 것으로 느낀다.
  // Coverage: ✅ integration
  test('progress is monotonic', () => {
    const after50: AskModelStatus = { state: 'loading', percent: 50 }
    expect(reduceAskModelProgress(after50, { status: 'progress', progress: 20 }))
      .toEqual({ state: 'loading', percent: 50 })
  })

  // Scenario: WebLLM 로딩이 끝나야 Ask 버튼을 켤 수 있다.
  // Coverage: ✅ integration
  test('ready sets 100 percent', () => {
    expect(reduceAskModelProgress({ state: 'loading', percent: 80 }, { status: 'ready' }))
      .toEqual({ state: 'ready', percent: 100 })
  })

  // Scenario: 다운로드 실패 후 사용자는 다시 시도할 수 있어야 한다.
  // Coverage: ✅ integration
  test('error preserves percent and records message', () => {
    expect(reduceAskModelProgress({ state: 'loading', percent: 30 }, { status: 'error', error: 'network' }))
      .toEqual({ state: 'error', percent: 30, message: 'network' })
  })
})

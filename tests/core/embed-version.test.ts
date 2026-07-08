import { needsReindex, EMBED_MODEL_VERSION } from '../../src/core/embed-version'

// Scenario: 모델이 Granite에서 BGE로 바뀌면 기존 벡터는 새 모델과 비교할 수 없다.
// Coverage: ✅ integration
test('needsReindex is true for a null or legacy stored version, false when equal', () => {
  expect(needsReindex(null, EMBED_MODEL_VERSION)).toBe(true)
  expect(needsReindex('granite-107m-r1-q8-v1', EMBED_MODEL_VERSION)).toBe(true)
  expect(needsReindex(EMBED_MODEL_VERSION, EMBED_MODEL_VERSION)).toBe(false)
})

// Scenario: 버전 문자열 오타는 재색인을 건너뛰게 만들 수 있다.
// Coverage: ✅ integration
test('version id is the selected bge base q8 identifier', () => {
  expect(EMBED_MODEL_VERSION).toBe('bge-base-en-v1.5-q8-v1')
})

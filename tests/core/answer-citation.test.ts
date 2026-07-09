import { expect, test } from 'vitest'
import { parseAnswerCitation } from '../../src/core/answer-citation'
import { NOT_FOUND_ANSWER } from '../../src/core/answer-generator'
import type { CapturedPage, RankedResult } from '../../src/core/model'

const page: CapturedPage = { id: 'p1', url: 'https://example.com/sleep', title: 'Sleep', capturedAt: 1 }
const result = (id: string, text: string): RankedResult => ({
  chunk: { id, pageId: 'p1', index: Number(id.split('#')[1]), text },
  page,
  score: 1,
})
const chunks: RankedResult[] = [
  result('p1#0', 'Cortisol can disrupt REM sleep.'),
  result('p1#1', 'Caffeine blocks adenosine receptors.'),
  result('p1#2', 'Blue light suppresses melatonin.'),
]

// Scenario: 모델이 형식을 정확히 지켜 여러 발췌를 인용하면, 그 발췌들의 청크 id가 그대로 출처가 돼야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation resolves cited excerpt numbers to chunk ids', () => {
  const raw = 'Cortisol and blue light both disrupt sleep.\n[[cite: 1, 3]]'
  const { displayText, citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(displayText).toBe('Cortisol and blue light both disrupt sleep.')
  expect(citedChunkIds).toEqual(['p1#0', 'p1#2'])
})

// Scenario: 모델이 범위 밖 번호나 중복 번호를 섞어도, 유효한 것만 걸러써야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation drops out-of-range and duplicate excerpt numbers', () => {
  const raw = 'Cortisol disrupts sleep.\n[[cite: 1, 1, 9]]'
  const { citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(citedChunkIds).toEqual(['p1#0'])
})

// Scenario: 모델이 태그를 아예 안 달면, 상위 청크로 대신 채우지 말고 출처를 비워야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation returns no sources when the model omits the tag', () => {
  const raw = 'Cortisol disrupts sleep.'
  const { displayText, citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(displayText).toBe('Cortisol disrupts sleep.')
  expect(citedChunkIds).toEqual([])
})

// Scenario: 태그 안에 유효한 번호가 하나도 없으면 출처를 비워야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation returns no sources when every tagged number is invalid', () => {
  const raw = 'Cortisol disrupts sleep.\n[[cite: 0, 99]]'
  const { citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(citedChunkIds).toEqual([])
})

// Scenario: 답변이 "저장된 자료에서 못 찾았다"는 고정 문구면, 태그가 있어도 출처를 강제로 비워야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation forces no sources when the answer is the not-found sentence', () => {
  const raw = `${NOT_FOUND_ANSWER}\n[[cite: 1]]`
  const { displayText, citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(displayText).toBe(NOT_FOUND_ANSWER)
  expect(citedChunkIds).toEqual([])
})

// Scenario: 화면에 보이는 텍스트에서 태그 줄이 깔끔히 잘려나가야 한다.
// Coverage: ✅ integration
test('parseAnswerCitation strips the citation tag from the displayed text', () => {
  const raw = 'Cortisol disrupts sleep.\n[[cite: 1]]'
  const { displayText } = parseAnswerCitation(raw, chunks)

  expect(displayText).not.toContain('[[cite:')
})

// Scenario: 청크가 하나뿐이면 태그 없이도(과거 동작과 달리) 여전히 출처가 비어야 한다 — 청크 1개 상황에서
// "태그 파싱"과 "무조건 상위 N개"가 우연히 같은 값을 내던 예전 사각지대를 이 테스트가 명시적으로 막는다.
// Coverage: ✅ integration
test('parseAnswerCitation does not fall back to the only chunk when no tag is present', () => {
  const single = [chunks[0]]
  const { citedChunkIds } = parseAnswerCitation('Cortisol disrupts sleep.', single)

  expect(citedChunkIds).toEqual([])
})

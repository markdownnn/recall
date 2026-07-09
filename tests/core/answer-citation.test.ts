import { expect, test } from 'vitest'
import { parseAnswerCitation } from '../../src/core/answer-citation'
import { NOT_FOUND_ANSWER } from '../../src/core/answer-generator'
import type { RankedResult } from '../../src/core/model'
import { rankedResult as result } from './fixtures'

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

// Scenario: 호출한 쪽이 "모델에게 실제로 보여준 발췌"만 chunks로 넘겨야 한다 — 이 함수는 넘어온 배열
// 길이를 곧 "모델이 볼 수 있었던 발췌 개수"로 신뢰한다. 만약 호출한 쪽이 모델에겐 5개만 보여주고 8개짜리
// 배열을 그대로 넘기면, 모델이 못 본 6~8번을 인용해도 "유효 범위"로 통과해버린다. 이 테스트는 함수가
// 딱 넘어온 배열 길이까지만 유효하다고 정확히 지키는지 확인한다(실제 5-vs-8 불일치는 호출부 수정으로
// 막는다 — 아래 webllm-answer-generator.test.ts 참고).
// Coverage: ✅ integration
test('parseAnswerCitation treats the passed-in chunks array as the full set of what was shown', () => {
  const shown = chunks.slice(0, 2) // pretend only 2 excerpts were actually shown to the model
  const raw = 'Cortisol disrupts sleep.\n[[cite: 3]]' // model cites a 3rd excerpt it was never shown
  const { citedChunkIds } = parseAnswerCitation(raw, shown)

  expect(citedChunkIds).toEqual([]) // 3 is out of range for the 2-item array that was actually passed
})

// Scenario: 모델이 태그 형식을 살짝 어겨도(숫자가 아닌 문자가 섞이는 등), 파싱은 실패하더라도 사용자
// 화면에는 내부 마커가 절대 그대로 새면 안 된다.
// Coverage: ✅ integration
test('parseAnswerCitation strips a malformed trailing tag instead of leaking it into the displayed text', () => {
  const raw = 'Cortisol disrupts sleep.\n[[cite: 1a]]'
  const { displayText, citedChunkIds } = parseAnswerCitation(raw, chunks)

  expect(displayText).toBe('Cortisol disrupts sleep.')
  expect(displayText).not.toContain('[[cite:')
  expect(citedChunkIds).toEqual([])
})

// Scenario: 답변 본문 중간에 "[[cite:"라는 글자가 우연히 들어가고(예: 태그 형식 자체를 설명하는 문장),
// 그 뒤에 진짜(그러나 깨진) 트레일링 태그가 따로 붙으면 — 잘라내는 기준점은 맨 마지막 "[[cite:"여야
// 한다. 첫 번째 등장 지점에서 잘라버리면 실제 답변 내용("More detail follows here.")이 통째로 사라진다.
// 앞쪽의 우연한 언급 자체는 실제 답변 내용이므로 남아 있어도 된다 — 오직 진짜(깨진) 트레일링 태그
// 시도만 잘려나가면 된다.
// Coverage: ✅ integration
test('parseAnswerCitation cuts at the LAST tag-shaped marker, not the first, when text mentions "[[cite:" earlier', () => {
  const raw = 'This app marks sources with a tag like [[cite: 1]] at the end.\n' +
    'More detail follows here.\n[[cite: 2]]x' // trailing tag has a stray "x" -> malformed
  const { displayText } = parseAnswerCitation(raw, chunks)

  expect(displayText).toContain('More detail follows here.')
  expect(displayText).not.toContain('[[cite: 2]]x')
})

import {
  precisionAt1,
  recallAtK,
  mrr,
  referenceSnippetRate,
  aggregate,
  evidenceRecallAtContext,
  confidenceGateCorrect,
} from '../../src/core/eval-metrics'

// Scenario: a ranked page-id list plus the expected id must produce the standard
// retrieval numbers used by the golden-set scorecard.
// Coverage: integration (pure arithmetic).
test('precisionAt1 is 1 only when the first id is expected', () => {
  expect(precisionAt1(['a', 'b'], ['a'])).toBe(1)
  expect(precisionAt1(['b', 'a'], ['a'])).toBe(0)
  expect(precisionAt1([], ['a'])).toBe(0)
})

test('recallAtK is 1 when any expected id is within the first k', () => {
  expect(recallAtK(['x', 'a', 'y'], ['a'], 5)).toBe(1)
  expect(recallAtK(['x', 'y', 'z', 'w', 'v', 'a'], ['a'], 5)).toBe(0) // a is at rank 6
  expect(recallAtK(['x'], ['a'], 5)).toBe(0)
})

test('mrr is the reciprocal rank of the first expected id (0 if absent)', () => {
  expect(mrr(['a', 'b'], ['a'])).toBe(1)
  expect(mrr(['b', 'a'], ['a'])).toBe(0.5)
  expect(mrr(['b', 'c'], ['a'])).toBe(0)
})

// Scenario: the headline regression number counts queries whose TOP-1 snippet is
// non-prose (a citation/boilerplate list).
// Coverage: integration (pure arithmetic).
test('referenceSnippetRate is the fraction of queries whose top snippet is non-prose', () => {
  expect(referenceSnippetRate([{ topIsProse: false }, { topIsProse: true }])).toBe(0.5)
  expect(referenceSnippetRate([{ topIsProse: true }, { topIsProse: true }])).toBe(0)
  expect(referenceSnippetRate([])).toBe(0)
})

test('aggregate averages per-query metrics', () => {
  const agg = aggregate([
    { p1: 1, r5: 1, rr: 1 },
    { p1: 0, r5: 1, rr: 0.5 },
  ])
  expect(agg.precisionAt1).toBe(0.5)
  expect(agg.recallAt5).toBe(1)
  expect(agg.mrr).toBe(0.75)
})

// Scenario: Ask가 LLM에 넘기는 최종 문맥 안에 정답 페이지의 청크가 있는가.
// Coverage: ✅ integration (pure arithmetic).
test('evidenceRecallAtContext is 1 when any context chunk belongs to an expected page', () => {
  expect(evidenceRecallAtContext(['p1', 'p2'], ['p2'])).toBe(1)
  expect(evidenceRecallAtContext(['p1', 'p2'], ['p3'])).toBe(0)
  expect(evidenceRecallAtContext([], ['p1'])).toBe(0)
})

// Scenario: 저신뢰 게이트의 판정이 실제로 "답 가능/불가능" 기대와 일치하는가.
// Coverage: ✅ integration (pure arithmetic).
test('confidenceGateCorrect compares the gate decision against expectAnswerable', () => {
  expect(confidenceGateCorrect(true, true)).toBe(1)
  expect(confidenceGateCorrect(false, false)).toBe(1)
  expect(confidenceGateCorrect(true, false)).toBe(0)
  expect(confidenceGateCorrect(false, true)).toBe(0)
})

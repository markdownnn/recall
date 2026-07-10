import { expect, test } from 'vitest'
import { dedupeSimilarQueries } from '../../src/core/query-dedup'

// Scenario: 코사인이 문턱 이상인 두 검색어가 있으면, 뒤에 나온 쪽을 버려야 한다.
// Coverage: ✅ integration
test('dedupeSimilarQueries drops a later query too similar to an earlier one', () => {
  const items = [
    { text: 'who invented rnn', vector: new Float32Array([1, 0]) },
    { text: 'who is the inventor of rnn', vector: new Float32Array([0.99, Math.sqrt(1 - 0.99 * 0.99)]) },
  ]

  const kept = dedupeSimilarQueries(items, 0.92)

  expect(kept.map((k) => k.text)).toEqual(['who invented rnn'])
})

// Scenario: 원본 질문(항상 첫 항목)은 절대 버리지 않아야 한다.
// Coverage: ✅ integration
test('dedupeSimilarQueries always keeps the first item', () => {
  const items = [{ text: 'only query', vector: new Float32Array([1, 0]) }]

  const kept = dedupeSimilarQueries(items, 0.92)

  expect(kept).toEqual(items)
})

// Scenario: 서로 충분히 다른 검색어들은 전부 살아남아야 한다.
// Coverage: ✅ integration
test('dedupeSimilarQueries keeps queries below the similarity threshold', () => {
  const items = [
    { text: 'rnn history', vector: new Float32Array([1, 0]) },
    { text: 'lstm inventors', vector: new Float32Array([0, 1]) },
  ]

  const kept = dedupeSimilarQueries(items, 0.92)

  expect(kept.map((k) => k.text)).toEqual(['rnn history', 'lstm inventors'])
})

// Scenario: 세 번째 검색어가 첫 번째와만 겹치고 두 번째와는 안 겹쳐도, 이미 채택된 어느 하나와
// 겹치면 버려야 한다(비교 대상은 "채택된 목록 전체", "직전 항목"이 아님).
// Coverage: ✅ integration
test('dedupeSimilarQueries compares against every already-kept item, not just the previous one', () => {
  const items = [
    { text: 'rnn history', vector: new Float32Array([1, 0]) },
    { text: 'lstm inventors', vector: new Float32Array([0, 1]) },
    { text: 'rnn origin story', vector: new Float32Array([0.99, Math.sqrt(1 - 0.99 * 0.99)]) },
  ]

  const kept = dedupeSimilarQueries(items, 0.92)

  expect(kept.map((k) => k.text)).toEqual(['rnn history', 'lstm inventors'])
})

import { rrfFuse } from '../../src/core/rrf'

test('fuses two ranked lists; agreement wins', () => {
  // a: top of list1, mid of list2. b: top of list2 only. c: only in list1 lower.
  const fused = rrfFuse([['a', 'c', 'b'], ['b', 'a']])
  expect(fused.map((r) => r.id)[0]).toBe('a') // appears high in both
  expect(fused.map((r) => r.id)).toContain('b')
  expect(fused.map((r) => r.id)).toContain('c')
})

test('id in one list only still appears', () => {
  const fused = rrfFuse([['x'], ['y']])
  expect(new Set(fused.map((r) => r.id))).toEqual(new Set(['x', 'y']))
})

test('empty lists -> empty', () => {
  expect(rrfFuse([[], []])).toEqual([])
})

// Fix 4: an optional per-list weight lets the lexical lane outweigh the vector lane so a
// page that LITERALLY contains the query term can beat an irrelevant high-cosine match,
// without changing the default (no-weights) behavior.
// Scenario: a default call is byte-for-byte today's behavior.
// Coverage: integration (pure RRF arithmetic).
test('default weights are unchanged (backward compatible)', () => {
  expect(rrfFuse([['a', 'b'], ['a']])[0].id).toBe('a')
})

// Scenario: equal weights tie a vector-only vs lexical-only top hit (insertion order keeps
// the vector one first); up-weighting the lexical lane lifts the lexical-only match above.
// Coverage: integration (pure RRF arithmetic).
test('up-weighting the lexical lane lifts a lexical-only match above a vector-only match', () => {
  const vectorIds = ['v']
  const lexicalIds = ['x']
  expect(rrfFuse([vectorIds, lexicalIds])[0].id).toBe('v')
  expect(rrfFuse([vectorIds, lexicalIds], 60, [1, 2])[0].id).toBe('x')
})

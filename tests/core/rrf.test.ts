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

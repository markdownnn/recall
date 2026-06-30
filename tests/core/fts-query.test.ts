import { toFtsQuery } from '../../src/core/fts-query'

test('ORs quoted terms of length >= 3', () => {
  expect(toFtsQuery('cortisol sleep')).toBe('"cortisol" OR "sleep"')
})

test('drops terms shorter than 3 chars (trigram needs 3)', () => {
  expect(toFtsQuery('a to cortisol')).toBe('"cortisol"')
})

test('neutralizes embedded quotes (no FTS syntax injection)', () => {
  // term `"hi"` is 4 chars (quote chars count toward the length filter), kept; its
  // internal quotes are doubled and the whole term re-wrapped -> """hi""".
  expect(toFtsQuery('say "hi"')).toBe('"say" OR """hi"""')
})

test('length filter counts code points (3+ kept, 2 dropped)', () => {
  // The filter is code-point based, so it behaves the same for CJK (a 3-syllable
  // Korean term is kept, a 2-syllable one dropped). Tested here with ASCII to keep
  // the test source ASCII-only; real Korean trigram matching is covered by the e2e.
  expect(toFtsQuery('abc xy')).toBe('"abc"')
})

test('no usable term -> null', () => {
  expect(toFtsQuery('a to')).toBeNull()
  expect(toFtsQuery('   ')).toBeNull()
})

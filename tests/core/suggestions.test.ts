import { SUGGESTIONS, randomIndex } from '../../src/ui/sidepanel/suggestions'

// Scenario: a fresh panel starts on a RANDOM suggestion (not always the first), but the
// chosen index must be a valid position in the list.
// Coverage: integration (pure; injected rng makes it deterministic).
test('randomIndex maps rng into an in-range position', () => {
  expect(randomIndex(SUGGESTIONS.length, () => 0)).toBe(0)
  expect(randomIndex(SUGGESTIONS.length, () => 0.999)).toBe(SUGGESTIONS.length - 1)
})

// Scenario: there must actually be a list to rotate (guards an empty-array regression
// that would make the placeholder blank forever).
// Coverage: integration (pure).
test('ships about ten English suggestions', () => {
  expect(SUGGESTIONS.length).toBeGreaterThanOrEqual(8)
  for (const s of SUGGESTIONS) expect(s.length).toBeGreaterThan(0)
})

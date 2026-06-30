import { needsReindex, EMBED_MODEL_VERSION } from '../../src/core/embed-version'

// Scenario: a profile that last embedded with a different (or no) model must trigger a
// re-index; a profile already on granite must not. The "same version" check is what keeps a
// granite device from re-indexing on every launch.
// Coverage: integration (the real pure decision function).
test('needsReindex is true for a null or legacy stored version, false when equal', () => {
  expect(needsReindex(null, EMBED_MODEL_VERSION)).toBe(true)
  expect(needsReindex('e5-small-q8-v1', EMBED_MODEL_VERSION)).toBe(true)
  expect(needsReindex(EMBED_MODEL_VERSION, EMBED_MODEL_VERSION)).toBe(false)
})

// Scenario: the version string is the single source of truth shared by the migration and the
// eval default. A typo silently disables the migration.
// Coverage: integration (locks the literal value).
test('version id is the granite r1 q8 identifier', () => {
  expect(EMBED_MODEL_VERSION).toBe('granite-107m-r1-q8-v1')
})

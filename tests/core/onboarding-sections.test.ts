import { SECTIONS, SECTION_KINDS } from '../../src/ui/onboarding/sections'
import { SAMPLES } from '../../src/ui/onboarding/samples'

// Scenario: the page renders each section through a renderer keyed by kind; a section whose
// kind has no renderer entry would crash at render. Pin every kind as known.
// Coverage: integration (real sections.ts).
test('every section kind is a known, renderable kind', () => {
  expect(SECTIONS.length).toBeGreaterThan(0)
  for (const s of SECTIONS) expect(SECTION_KINDS).toContain(s.kind)
})

// Scenario: duplicate ids would make the keyed map() collide and the scroll order ambiguous.
// Coverage: integration (real sections.ts).
test('section ids are unique', () => {
  const ids = SECTIONS.map((s) => s.id)
  expect(new Set(ids).size).toBe(ids.length)
})

// Scenario: the page must open on the hero and end on the Open Recall guide (the call to
// action); a reorder that broke that would ship a confusing first-run page.
// Coverage: integration (real sections.ts).
test('the scroll opens on hero and ends on open-recall', () => {
  expect(SECTIONS[0].kind).toBe('hero')
  expect(SECTIONS[SECTIONS.length - 1].kind).toBe('open-recall')
})

// Scenario: exactly one live try-it card, and it must seed the SAME bundled SAMPLES the
// validation guards; a divergent inline list would seed unvalidated docs.
// Coverage: integration (real sections.ts).
test('there is one try-it section and it seeds the bundled SAMPLES', () => {
  const tryIts = SECTIONS.filter((s) => s.kind === 'try-it')
  expect(tryIts.length).toBe(1)
  const t = tryIts[0]
  if (t.kind === 'try-it') expect(t.samples).toBe(SAMPLES)
})

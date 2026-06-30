import { proseScore } from '../../src/core/prose-score'

// A real-shaped lead paragraph (prose).
const LEAD =
  'Bacteria are ubiquitous, mostly free-living organisms often consisting of one ' +
  'biological cell. They constitute a large domain of prokaryotic microorganisms and ' +
  'were among the first life forms to appear on Earth.'

// A real-shaped citation chunk (boilerplate): journal names, DOIs, PMIDs, years.
const CITATION =
  'Douady CJ, Papke RT (2003). "Lateral gene transfer". Journal of Experimental Botany. ' +
  '56 (417): 1761-78. doi:10.1093/jxb/eri197. PMID 12498710. S2CID 8521523. ISSN 0022-0957. ' +
  'Bibcode 2003JXB....56.1761D. Retrieved 2019-03-14.'

// Scenario: a lead/intro paragraph must score HIGH; a dense Wikipedia citation chunk
// must score LOW so downstream code can drop or de-prioritize it.
// Coverage: integration (pure function, fixed ASCII samples).
test('lead prose scores high', () => {
  expect(proseScore(LEAD)).toBeGreaterThan(0.7)
})

test('citation chunk scores low', () => {
  expect(proseScore(CITATION)).toBeLessThan(0.35)
})

test('prose outscores citation', () => {
  expect(proseScore(LEAD)).toBeGreaterThan(proseScore(CITATION))
})

test('empty text scores 0 (no prose to show)', () => {
  expect(proseScore('')).toBe(0)
  expect(proseScore('   ')).toBe(0)
})

test('score is clamped to [0,1]', () => {
  const s = proseScore(CITATION)
  expect(s).toBeGreaterThanOrEqual(0)
  expect(s).toBeLessThanOrEqual(1)
})

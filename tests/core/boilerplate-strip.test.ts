import { stripBoilerplate } from '../../src/core/boilerplate-strip'

const BODY = [
  'Bacteria are ubiquitous, mostly free-living organisms.',
  'They constitute a large domain of prokaryotic microorganisms.',
].join('\n')

// Scenario: block-joined extracted text ending in a References/See also/External links
// block must come back with the body intact and the boilerplate tail removed; a page
// with no such heading must be returned unchanged.
// Coverage: integration (pure text->text function, fixed ASCII multi-line samples).
test('removes a trailing References section and everything after it', () => {
  const input = [BODY, 'References', '1. Some Author (2003). doi:10.1/x. PMID 123.'].join('\n')
  const out = stripBoilerplate(input)
  expect(out).toContain('Bacteria are ubiquitous')
  expect(out).not.toContain('References')
  expect(out).not.toContain('PMID 123')
})

test('removes from the FIRST boilerplate heading to end (See also + External links stacked)', () => {
  const input = [BODY, 'See also', 'Related topic', 'External links', 'http://example.org'].join('\n')
  const out = stripBoilerplate(input)
  expect(out).toContain('large domain')
  expect(out).not.toContain('See also')
  expect(out).not.toContain('External links')
  expect(out).not.toContain('example.org')
})

test('heading match is case-insensitive and tolerates a trailing [edit]', () => {
  const input = [BODY, 'NOTES [edit]', 'a footnote'].join('\n')
  expect(stripBoilerplate(input)).not.toContain('footnote')
})

test('a page with no boilerplate heading is returned unchanged', () => {
  expect(stripBoilerplate(BODY)).toBe(BODY)
})

test('a boilerplate WORD inside a sentence (not its own line) is NOT a cut point', () => {
  const input = 'See the references in the appendix for more on bacteria growth.'
  expect(stripBoilerplate(input)).toBe(input) // conservative: only a stand-alone heading line cuts
})

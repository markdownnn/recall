import { parseHTML } from 'linkedom'
import {
  REFERENCE_SELECTORS,
  REFERENCE_SECTION_HEADING_IDS,
  cleanReferenceNodes,
} from '../../src/core/reference-clean'

// linkedom gives us a real Document/Element with querySelectorAll/closest/remove, the same
// DOM surface the production content script and the eval harness use. cleanReferenceNodes is
// a pure DOM-in / DOM-out function (no chrome, no globals), so we drive it straight off a
// small fixture string and assert on the surviving text.
function clean(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  cleanReferenceNodes(document.documentElement)
  return document.body?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

// Scenario: a Wikipedia paragraph carries inline [1][2] citation markers (sup.reference);
// those markers must vanish so the embedded prose is not littered with citation numbers.
// Coverage: integration (real linkedom DOM, selector applied end to end).
test('removes inline sup.reference citation markers but keeps the prose', () => {
  const out = clean(
    '<p>Bacteria are everywhere<sup class="reference">[1]</sup> and ancient<sup class="reference">[2]</sup>.</p>',
  )
  expect(out).toContain('Bacteria are everywhere')
  expect(out).toContain('and ancient')
  expect(out).not.toContain('[1]')
  expect(out).not.toContain('[2]')
})

// Scenario: the various MediaWiki citation-list containers (.reflist, ol.references,
// .mw-references-wrap) hold dozens of doi/PMID rows that pollute embeddings; each container
// shape must be dropped wholesale.
// Coverage: integration (one fixture per container selector).
test('removes reflist / ol.references / mw-references-wrap containers', () => {
  const out = clean(
    '<p>Body prose here.</p>' +
      '<div class="reflist"><ol><li>Author A. doi:10.1/x.</li></ol></div>' +
      '<ol class="references"><li>Author B. PMID 123.</li></ol>' +
      '<div class="mw-references-wrap"><ol><li>Author C. arXiv.</li></ol></div>',
  )
  expect(out).toContain('Body prose here.')
  expect(out).not.toContain('doi:10.1/x')
  expect(out).not.toContain('PMID 123')
  expect(out).not.toContain('arXiv')
})

// Scenario: Parsoid (Wikimedia REST) wraps each section in <section> with the id on the
// heading itself (<h2 id="References">); the whole boilerplate section must go while the
// real lead section stays.
// Coverage: integration (Parsoid section shape).
test('removes a Parsoid <section> whose heading id is a known boilerplate id', () => {
  const out = clean(
    '<section><h2 id="Lead">Overview</h2><p>Real article body.</p></section>' +
      '<section><h2 id="References">References</h2><ol><li>cite row one</li></ol></section>' +
      '<section><h2 id="See_also">See also</h2><ul><li>related link</li></ul></section>',
  )
  expect(out).toContain('Real article body.')
  expect(out).not.toContain('References')
  expect(out).not.toContain('cite row one')
  expect(out).not.toContain('See also')
  expect(out).not.toContain('related link')
})

// Scenario: legacy MediaWiki (action-API parse) is FLAT - <h2><span id="References">...
// followed by sibling lists, then the next <h2>. We must cut from that heading up to (but
// not including) the next same-rank heading, leaving later real sections intact.
// Coverage: integration (legacy flat shape with id on the headline span).
test('removes a flat legacy heading section up to the next same-rank heading', () => {
  const out = clean(
    '<h2><span class="mw-headline" id="Body">Body</span></h2><p>Lead paragraph stays.</p>' +
      '<h2><span class="mw-headline" id="Notes">Notes</span></h2><ul><li>a footnote row</li></ul>' +
      '<h2><span class="mw-headline" id="Gallery">Gallery</span></h2><p>Kept tail prose.</p>',
  )
  expect(out).toContain('Lead paragraph stays.')
  expect(out).toContain('Kept tail prose.')
  expect(out).not.toContain('a footnote row')
})

// Scenario: an ordinary article with no reference markup must come through untouched - the
// pre-clean must never delete real body text.
// Coverage: integration (no-op guard).
test('leaves a document without reference markup unchanged', () => {
  const out = clean('<p>Just prose.</p><p>More prose.</p>')
  // textContent concatenates block text without a separator; the point is nothing was deleted.
  expect(out).toBe('Just prose.More prose.')
})

// Scenario: a pathological page whose ENTIRE body is a reference container (here ol.references
// with nothing else) must NOT be emptied. Unlike boilerplate-strip (bounded by minIndex), these
// removals are unconditional, so without a guard the whole article would vanish. The guard must
// detect that removal would leave no text and skip it, keeping the body (a noisy page beats an
// empty one).
// Coverage: integration (real linkedom DOM, all-references body).
test('keeps the body when removing references would empty the whole article', () => {
  const out = clean('<ol class="references"><li>cite row one</li><li>cite row two</li></ol>')
  expect(out).toContain('cite row one')
  expect(out).toContain('cite row two')
})

// Scenario: same guard for a heading-anchored section that is the entire body (a page that is
// nothing but a "References" section). Removal would empty it, so it must be skipped.
// Coverage: integration (real linkedom DOM, all-references heading section).
test('keeps the body when a heading-section removal would empty the whole article', () => {
  const out = clean(
    '<section><h2 id="References">References</h2><ol><li>only citations here</li></ol></section>',
  )
  expect(out).toContain('only citations here')
})

// Scenario: the guard must NOT make removal too timid - when there is real body text alongside
// the references, the references must still be dropped (regression guard for the guard).
// Coverage: integration (real linkedom DOM, mixed body).
test('still removes references when real body text remains', () => {
  const out = clean(
    '<p>Real body prose.</p><ol class="references"><li>cite row</li></ol>',
  )
  expect(out).toContain('Real body prose.')
  expect(out).not.toContain('cite row')
})

// Scenario: the selector/id lists are the load-bearing contract; lock the exact members so a
// future careless edit that drops a selector is caught.
// Coverage: integration (pure constant assertion).
test('exposes the exact selector and heading-id contract', () => {
  expect(REFERENCE_SELECTORS).toEqual([
    'sup.reference',
    '.reflist',
    'ol.references',
    '.mw-references-wrap',
  ])
  expect(REFERENCE_SECTION_HEADING_IDS).toEqual([
    'References',
    'See_also',
    'Notes',
    'External_links',
    'Bibliography',
  ])
})

// DOM-level reference/citation pre-clean - run on the CLONED document BEFORE Readability.
//
// This is the structural counterpart to the text-level stripBoilerplate(): instead of keying
// on heading WORDS in already-extracted text, it removes reference DOM by SELECTOR/id, so it
// also kills inline [1] citation markers and is robust to the exact heading wording. The two
// are complementary and BOTH stay wired: this drops the Wikipedia citation structure up front,
// and stripBoilerplate remains the text-level safety net for non-Wikipedia pages whose DOM
// shape we do not know.
//
// Pure: takes a DOM root (Document.documentElement, or any Element/Document) and mutates it in
// place using only standard DOM APIs (querySelectorAll / closest / remove). No extension
// globals - so it runs identically in the content script, in linkedom (the eval harness), and
// in unit tests.

// Containers + inline markers we delete outright wherever they appear.
export const REFERENCE_SELECTORS = [
  'sup.reference', // inline [1] citation superscripts inside prose
  '.reflist', // MediaWiki reference-list wrapper (legacy)
  'ol.references', // the <ol> of citation rows
  '.mw-references-wrap', // MediaWiki references wrapper
]

// Wikipedia section heading ids whose ENTIRE section (heading + everything under it up to the
// next same-or-higher heading) is boilerplate.
export const REFERENCE_SECTION_HEADING_IDS = [
  'References',
  'See_also',
  'Notes',
  'External_links',
  'Bibliography',
]

const HEADING_SEL = 'h1,h2,h3,h4,h5,h6'

function headingLevel(el: Element | null): number {
  if (!el) return 0
  const m = /^h([1-6])$/.exec(el.tagName.toLowerCase())
  return m ? Number(m[1]) : 0
}

function firstHeading(section: Element): Element | null {
  for (const child of [...section.children]) {
    if (headingLevel(child) > 0) return child
  }
  return null
}

// Remove the boilerplate section anchored at the element carrying a known id. The id can sit
// on the heading itself (Parsoid: <h2 id="References">) or on the headline span inside it
// (legacy: <h2><span id="References">). Two real Wikipedia shapes:
//   1. Parsoid wraps each section in <section> -> if this heading is that section's first
//      heading, drop the whole <section>.
//   2. Legacy layout is FLAT -> drop the heading and its following siblings until the next
//      heading of the same or higher rank (so later real sections survive).
function removeHeadingSection(node: Element): void {
  const heading = node.closest(HEADING_SEL) ?? node
  const section = heading.closest('section')
  if (section && firstHeading(section) === heading) {
    section.remove()
    return
  }
  const level = headingLevel(heading)
  // id was not on / inside a heading and there is no section to anchor on: only remove the
  // tagged node itself, never a run of siblings (avoid deleting unrelated body).
  if (level === 0) {
    node.remove()
    return
  }
  let el: Element | null = heading
  while (el) {
    const next: Element | null = el.nextElementSibling
    el.remove()
    if (next && headingLevel(next) > 0 && headingLevel(next) <= level) break
    el = next
  }
}

function applyRemovals(root: ParentNode): void {
  for (const sel of REFERENCE_SELECTORS) {
    for (const el of [...root.querySelectorAll(sel)]) el.remove()
  }
  for (const id of REFERENCE_SECTION_HEADING_IDS) {
    const node = root.querySelector(`[id="${id}"]`)
    if (node) removeHeadingSection(node)
  }
}

// Non-whitespace text length of a node's subtree. Used to detect "removal would empty the
// article". textContent is on Node (Element/Document both have it); ParentNode does not declare
// it, so we read it through a narrow cast.
function nonWhitespaceLen(root: ParentNode): number {
  const t = (root as unknown as { textContent: string | null }).textContent ?? ''
  return t.replace(/\s+/g, '').length
}

export function cleanReferenceNodes<T extends ParentNode>(root: T): T {
  // All-dropped guard. Unlike boilerplate-strip (bounded by minIndex so it only cuts the tail),
  // these removals are UNCONDITIONAL - a pathological page whose entire body sits under a
  // reference selector/section would be emptied. Dry-run the removals on a deep clone first; if
  // that would leave no real text behind, skip the removal and keep the body (a noisy page beats
  // an empty one). Otherwise commit the same removals to the real root.
  const clone = (root as unknown as { cloneNode(deep: boolean): ParentNode }).cloneNode(true)
  applyRemovals(clone)
  if (nonWhitespaceLen(clone) === 0 && nonWhitespaceLen(root) > 0) {
    return root
  }
  applyRemovals(root)
  return root
}

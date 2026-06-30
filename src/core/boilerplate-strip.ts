// Remove trailing boilerplate sections (References / Notes / See also / External links /
// Bibliography / Further reading / Sources / Citations) from EXTRACTED, block-joined text
// (one block per line). On Wikipedia these sections are all stacked at the very bottom, so
// the robust, conservative rule is: find the EARLIEST line in the tail that is EXACTLY a
// known heading, and drop from there to the end.
//
// "Conservative" guards against over-stripping body text:
//   - the line must EQUAL a heading (after lowercasing, trimming, stripping a trailing
//     "[edit]") - a sentence that merely mentions "references" is never a cut point;
//   - only cut when the heading is in the LATTER portion of the document (>= 40% down),
//     so an early "Notes" callout box does not delete the article.
const HEADINGS = new Set([
  'references',
  'reference',
  'notes',
  'note',
  'citations',
  'see also',
  'external links',
  'further reading',
  'bibliography',
  'sources',
])

function isHeadingLine(line: string): boolean {
  const norm = line.trim().toLowerCase().replace(/\s*\[edit\]\s*$/, '').trim()
  return HEADINGS.has(norm)
}

export function stripBoilerplate(text: string): string {
  const lines = text.split('\n')
  const minIndex = Math.floor(lines.length * 0.4) // only cut in the tail
  let cut = -1
  for (let i = minIndex; i < lines.length; i++) {
    if (isHeadingLine(lines[i])) {
      cut = i
      break
    }
  }
  if (cut === -1) return text
  return lines.slice(0, cut).join('\n').replace(/\n+$/, '')
}

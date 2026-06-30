// How much does a chunk read like running prose (intro/explanation) vs. a citation /
// boilerplate list? 1 = clean prose, 0 = dense citation list. Pure + deterministic so it
// can drive the eval metric, the index-time filter (Fix 2), and the snippet swap (Fix 3).
//
// Signals (cheap, language-agnostic - works for English AND Korean prose because the
// alpha-word test accepts any Unicode LETTER, not just A-Z):
//   digitDensity   = digit chars / total chars        (citation lists are year/page-number heavy)
//   alphaWordRatio = words starting with a letter / words  (citations are number/punctuation heavy)
//   citeMarkers    = count of doi|PMID|PMC|ISSN|ISBN|Bibcode|arXiv|S2CID  (smoking gun)
// Link density is intentionally NOT used here: the input is already plain text (links are
// gone after extraction), so there is nothing to measure.
const CITE_MARKER = /\b(doi|PMID|PMC|ISSN|ISBN|Bibcode|arXiv|S2CID)\b/gi

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export function proseScore(text: string): number {
  const t = text.trim()
  if (t.length === 0) return 0

  const chars = [...t]
  const digitCount = chars.filter((c) => c >= '0' && c <= '9').length
  const digitDensity = digitCount / chars.length

  const words = t.split(/\s+/).filter((w) => w.length > 0)
  // A "word" starts with a Unicode letter (English, Korean, etc.) - not a digit/quote/paren.
  const alphaWords = words.filter((w) => /^[\p{L}]/u.test(w)).length
  const alphaWordRatio = words.length === 0 ? 0 : alphaWords / words.length

  const citeMarkers = (t.match(CITE_MARKER) ?? []).length

  return clamp(
    1 -
      2.0 * Math.max(0, digitDensity - 0.04) -
      0.8 * Math.max(0, 0.7 - alphaWordRatio) -
      0.05 * citeMarkers,
    0,
    1,
  )
}

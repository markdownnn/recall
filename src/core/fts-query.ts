// Turn a free-text query into an FTS5 MATCH expression for the trigram tokenizer.
// - split on whitespace
// - keep terms with >= 3 characters (a trigram needs 3 chars; shorter can't match)
// - wrap each term in double quotes (a phrase) with internal quotes doubled, so user
//   text can never inject FTS5 operators or cause a MATCH syntax error
// - OR the terms (lexical supplies candidates; RRF + vector handle precision)
// Returns null when no term qualifies, so the caller does vector-only search.
export function toFtsQuery(text: string): string | null {
  const terms = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => [...t].length >= 3)
  if (terms.length === 0) return null
  return terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
}

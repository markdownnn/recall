// EXPERIMENTAL chunker for the A2 "does sentence-overlap chunking lift recall?" A/B.
//
// The production ParagraphChunker cuts a flat word stream every maxWords with NO overlap and
// NO sentence awareness, so a fact straddling a cut lands half in each neighbour and its
// embedding is blurred. This spike cuts at sentence boundaries and repeats the last N
// sentences at the start of the next chunk (overlap), so a boundary-straddling fact appears
// whole in at least one chunk.
//
// This is a MEASUREMENT SPIKE, not production code: the sentence splitter is a simple
// punctuation regex (good enough to size the retrieval effect). If the lift is real, port it
// into ParagraphChunker with full TDD and a more robust splitter.
//   env: EVAL_CHUNK_MAXWORDS (default 220), EVAL_CHUNK_OVERLAP (sentences, default 1)

function splitSentences(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return []
  // Break after . ! ? when followed by whitespace. Crude but adequate for English prose.
  return flat.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0)
}

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length
}

export class SentenceOverlapChunker {
  constructor(maxWords = 220, overlapSentences = 1) {
    this.maxWords = maxWords
    this.overlap = overlapSentences
  }

  chunk(input) {
    const sentences = splitSentences(input.text)

    // A single sentence longer than the budget can't cut at its own boundary, so fall back to
    // word slices; each slice becomes its own packable unit (all units are <= maxWords words).
    const units = []
    for (const s of sentences) {
      if (wordCount(s) <= this.maxWords) {
        units.push(s)
      } else {
        const words = s.split(/\s+/).filter(Boolean)
        for (let i = 0; i < words.length; i += this.maxWords) {
          units.push(words.slice(i, i + this.maxWords).join(' '))
        }
      }
    }

    // Greedily pack units up to the word budget; between chunks, step back `overlap` units so
    // the tail sentences repeat at the head of the next chunk. start+1 floor guarantees progress.
    const pieces = []
    let idx = 0
    while (idx < units.length) {
      const start = idx
      let words = 0
      while (idx < units.length && (words === 0 || words + wordCount(units[idx]) <= this.maxWords)) {
        words += wordCount(units[idx])
        idx += 1
      }
      pieces.push(units.slice(start, idx).join(' '))
      if (idx < units.length && this.overlap > 0) {
        idx = Math.max(start + 1, idx - this.overlap)
      }
    }

    return pieces.map((text, index) => ({ id: `${input.pageId}#${index}`, pageId: input.pageId, index, text }))
  }
}

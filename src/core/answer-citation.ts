import type { RankedResult } from './model'
import { NOT_FOUND_ANSWER } from './answer-generator'

// Trailing hidden marker the model appends to point at which numbered excerpt(s) it used.
// Anchored to the END of the text (no /m flag) so it only matches the final line, not any
// "[[cite: ...]]"-shaped text that might appear mid-answer for some other reason.
const CITATION_TAG_PATTERN = /\n?\[\[cite:\s*([0-9,\s]+)\]\]\s*$/i
// Looser, unanchored fallback: matches just the opening of the marker. Used only to find
// where to cut the displayed text when the model emits something tag-SHAPED but malformed
// (e.g. "[[cite: 1a]]" or a stray trailing character) that CITATION_TAG_PATTERN can't fully
// match. Without this, a malformed tag falls all the way through to "no tag found" and the
// raw "[[cite: ...]]" text leaks onto the user's screen, breaking the prompt's promise that
// this marker is hidden.
const CITATION_TAG_START = /\n?\[\[cite:/i

export interface ParsedCitation {
  displayText: string
  citedChunkIds: string[]
}

// Parses the model's raw answer into what the user should see (displayText, tag stripped)
// and which chunks it actually cited (citedChunkIds). No fallback: a missing or invalid tag
// means citedChunkIds is empty rather than guessing at the top chunks (ADR 0024). `chunks`
// must be exactly the excerpts the model was actually shown in the prompt (the caller is
// responsible for passing the same slice used to build the prompt, not a larger array) --
// citation numbers are validated against chunks.length, so a larger array would let the
// model "cite" an excerpt it never saw.
export function parseAnswerCitation(rawText: string, chunks: RankedResult[]): ParsedCitation {
  const match = rawText.match(CITATION_TAG_PATTERN)
  const cut = match ?? rawText.match(CITATION_TAG_START)
  const displayText = cut ? rawText.slice(0, cut.index).trimEnd() : rawText

  if (!match || displayText.trim() === NOT_FOUND_ANSWER) {
    return { displayText, citedChunkIds: [] }
  }

  const seen = new Set<number>()
  const citedChunkIds: string[] = []
  for (const raw of match[1].split(',')) {
    const n = Number(raw.trim())
    if (!Number.isInteger(n) || n < 1 || n > chunks.length) continue
    if (seen.has(n)) continue
    seen.add(n)
    citedChunkIds.push(chunks[n - 1].chunk.id)
  }
  return { displayText, citedChunkIds }
}

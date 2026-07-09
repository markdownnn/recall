import type { RankedResult } from './model'
import { NOT_FOUND_ANSWER } from './answer-generator'

// Trailing hidden marker the model appends to point at which numbered excerpt(s) it used.
// Anchored to the END of the text (no /m flag) so it only matches the final line, not any
// "[[cite: ...]]"-shaped text that might appear mid-answer for some other reason.
const CITATION_TAG_PATTERN = /\n?\[\[cite:\s*([0-9,\s]+)\]\]\s*$/i

export interface ParsedCitation {
  displayText: string
  citedChunkIds: string[]
}

// Parses the model's raw answer into what the user should see (displayText, tag stripped)
// and which chunks it actually cited (citedChunkIds). No fallback: a missing or fully-invalid
// tag means citedChunkIds is empty rather than guessing at the top chunks (ADR 0024).
export function parseAnswerCitation(rawText: string, chunks: RankedResult[]): ParsedCitation {
  const match = rawText.match(CITATION_TAG_PATTERN)
  const displayText = match ? rawText.slice(0, match.index).trimEnd() : rawText

  if (displayText.trim() === NOT_FOUND_ANSWER) {
    return { displayText, citedChunkIds: [] }
  }
  if (!match) {
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

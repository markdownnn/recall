import type { ContentChunkerPort } from './ports'
import type { Chunk } from './model'

export class ParagraphChunker implements ContentChunkerPort {
  // maxWords:        max words accumulated before flushing a chunk.
  // maxCharsPerWord: code-point threshold for hard-splitting a single spaceless token.
  //                  Sized to keep spaceless CJK runs under e5's 512-token limit.
  //                  Does NOT bound multi-word accumulation — only per-word hard splits.
  constructor(
    private maxWords = 220,
    private maxCharsPerWord = 350,
  ) {}

  chunk(input: { pageId: string; text: string }): Chunk[] {
    // Treat the entire text as one word stream.
    // Splitting on /\s+/ means blank lines (paragraph boundaries) are just whitespace —
    // they do NOT force a flush. Short paragraphs are merged together.
    const words = input.text.split(/\s+/).filter((w) => w.length > 0)

    const pieces: string[] = []
    let current: string[] = []

    const flushCurrent = () => {
      if (current.length > 0) {
        pieces.push(current.join(' '))
        current = []
      }
    }

    for (const word of words) {
      const codePoints = Array.from(word).length

      if (codePoints > this.maxCharsPerWord) {
        // Flush any accumulated words first, then hard-split this token
        // at code-point boundaries so surrogate pairs / emoji are never torn.
        flushCurrent()
        const cps = Array.from(word)
        for (let i = 0; i < cps.length; i += this.maxCharsPerWord) {
          pieces.push(cps.slice(i, i + this.maxCharsPerWord).join(''))
        }
        continue
      }

      // Normal word: flush the buffer when it has reached the word budget.
      if (current.length >= this.maxWords) {
        flushCurrent()
      }
      current.push(word)
    }

    flushCurrent()

    return pieces.map((text, index) => ({
      id: `${input.pageId}#${index}`,
      pageId: input.pageId,
      index,
      text,
    }))
  }
}

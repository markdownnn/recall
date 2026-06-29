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
    const paras = input.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)

    const pieces: string[] = []

    for (const para of paras) {
      const words = para.split(/\s+/)
      let current: string[] = []

      for (const word of words) {
        const codePoints = Array.from(word).length

        if (codePoints > this.maxCharsPerWord) {
          // Flush the current word buffer before hard-splitting this token.
          if (current.length > 0) {
            pieces.push(current.join(' '))
            current = []
          }
          // Hard-split at code-point boundaries so surrogate pairs / emoji are never torn.
          const cps = Array.from(word)
          for (let i = 0; i < cps.length; i += this.maxCharsPerWord) {
            pieces.push(cps.slice(i, i + this.maxCharsPerWord).join(''))
          }
          continue
        }

        // Normal word: flush the buffer if it has reached the word budget.
        if (current.length >= this.maxWords) {
          pieces.push(current.join(' '))
          current = []
        }
        current.push(word)
      }

      if (current.length > 0) {
        pieces.push(current.join(' '))
      }
    }

    return pieces.map((text, index) => ({
      id: `${input.pageId}#${index}`,
      pageId: input.pageId,
      index,
      text,
    }))
  }
}

import type { ContentChunkerPort } from './ports'
import type { Chunk } from './model'

export class ParagraphChunker implements ContentChunkerPort {
  constructor(
    private readonly maxWords = 220,
    private readonly maxChars = 400,
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
      let currentChars = 0

      for (const word of words) {
        // If this single word exceeds maxChars, flush current then hard-split the word
        if (word.length > this.maxChars) {
          if (current.length > 0) {
            pieces.push(current.join(' '))
            current = []
            currentChars = 0
          }
          for (let i = 0; i < word.length; i += this.maxChars) {
            pieces.push(word.slice(i, i + this.maxChars))
          }
          continue
        }

        // Would adding this word exceed maxWords or maxChars?
        const newChars = currentChars === 0 ? word.length : currentChars + 1 + word.length
        if (current.length >= this.maxWords || newChars > this.maxChars) {
          if (current.length > 0) {
            pieces.push(current.join(' '))
          }
          current = []
          currentChars = 0
        }

        current.push(word)
        currentChars = currentChars === 0 ? word.length : currentChars + 1 + word.length
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

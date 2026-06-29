import type { ContentChunkerPort } from './ports'
import type { Chunk } from './model'

export class ParagraphChunker implements ContentChunkerPort {
  constructor(private readonly maxWords = 220) {}

  chunk(input: { pageId: string; text: string }): Chunk[] {
    const paras = input.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)

    const pieces: string[] = []
    for (const para of paras) {
      const words = para.split(/\s+/)
      for (let i = 0; i < words.length; i += this.maxWords) {
        pieces.push(words.slice(i, i + this.maxWords).join(' '))
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

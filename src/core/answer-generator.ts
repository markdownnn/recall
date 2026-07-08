import type { RankedResult } from './model'

export interface AnswerRequest {
  question: string
  chunks: RankedResult[]
}

export interface AnswerDraft {
  text: string
  citedChunkIds: string[]
}

export interface AnswerGeneratorPort {
  answer(request: AnswerRequest): Promise<AnswerDraft>
}

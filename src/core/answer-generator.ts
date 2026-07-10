import type { RankedResult } from './model'

export interface AnswerRequest {
  question: string
  chunks: RankedResult[]
}

export interface AnswerDraft {
  text: string
  citedChunkIds: string[]
}

export type AskProgressEvent = { type: 'expanded-queries'; queries: string[] }

export interface AnswerGeneratorPort {
  answer(request: AnswerRequest): Promise<AnswerDraft>
  answerStream?(request: AnswerRequest, onDelta: (delta: string) => void): Promise<AnswerDraft>
  expandQueries?(question: string): Promise<string[]>
}

export const NOT_FOUND_ANSWER = "I couldn't find that in your saved pages."

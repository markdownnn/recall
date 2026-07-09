export interface AnswerRetrievalOptions {
  pageK: number
  hitsPerPage: number
  neighborWindow: number
  maxContextChunks: number
}

export const DEFAULT_ANSWER_RETRIEVAL_OPTIONS: AnswerRetrievalOptions = {
  pageK: 3,
  hitsPerPage: 2,
  neighborWindow: 1,
  maxContextChunks: 14,
}

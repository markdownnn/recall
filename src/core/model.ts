export interface Chunk {
  id: string          // `${pageId}#${index}`
  pageId: string
  index: number
  text: string
}

export interface CapturedPage {
  id: string          // normalized URL
  url: string
  title: string
  capturedAt: number
}

export interface RankedResult {
  chunk: Chunk
  page: CapturedPage
  score: number
}

export interface RecallQuery {
  text: string
  k: number
}

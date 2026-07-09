import type { CapturedPage, RankedResult } from '../../src/core/model'

// Shared minimal saved-page fixture for Ask/citation tests that don't care about page
// content, only that a RankedResult has a valid page to point at.
export const ASK_TEST_PAGE: CapturedPage = {
  id: 'p1',
  url: 'https://example.com/sleep',
  title: 'Sleep',
  capturedAt: 1,
}

// Builds a RankedResult from a chunk id (`${pageId}#${index}`) and its text, defaulting to
// ASK_TEST_PAGE. score defaults to 1 since most tests using this only care about identity/
// text, not ranking.
export function rankedResult(id: string, text: string, page: CapturedPage = ASK_TEST_PAGE): RankedResult {
  return {
    chunk: { id, pageId: page.id, index: Number(id.split('#')[1]), text },
    page,
    score: 1,
  }
}

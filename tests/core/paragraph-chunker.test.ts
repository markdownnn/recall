import { ParagraphChunker } from '../../src/core/paragraph-chunker'

const chunker = new ParagraphChunker(5) // maxWords=5 for testing

// Scenario: Two short paragraphs that are both under maxWords should merge into one chunk,
// not remain separate  -  this is the core behavior change vs. the old per-paragraph flush.
// Coverage: integration (pure chunking logic, no external deps).
test('merges across blank lines: two short paras become one chunk', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'first para\n\nsecond para' })
  // 'first', 'para', 'second', 'para' = 4 words < maxWords(5) => one chunk
  expect(chunks.length).toBe(1)
  expect(chunks[0].text).toBe('first para second para')
})

// Scenario: A word stream that exceeds maxWords must be split into multiple chunks.
// Coverage: unit (pure logic).
test('maxWords split: 7 words with maxWords=5 -> two chunks', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'one two three four five six seven' })
  expect(chunks.length).toBe(2)
  expect(chunks[0].text).toBe('one two three four five')
  expect(chunks[1].text).toBe('six seven')
})

// Scenario: Chunk ids and indices must be stable so that downstream systems (e.g. the
// embedder, the DB) can reference chunks by deterministic id.
// Coverage: unit.
test('assigns stable ids and indices', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'one two three four five six seven' })
  expect(chunks[0]).toMatchObject({ id: 'p1#0', pageId: 'p1', index: 0 })
  expect(chunks[1]).toMatchObject({ id: 'p1#1', pageId: 'p1', index: 1 })
})

// Scenario: Extra blank lines and whitespace-only lines must not produce empty chunks
// or keep words apart; only actual word content matters.
// Coverage: unit.
test('ignores extra whitespace and blank lines: a and b merge into one chunk', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'a\n\n\n\n   \n\nb' })
  expect(chunks.length).toBe(1)
  expect(chunks[0].text).toBe('a b')
})

// Scenario: 100 short English words well under the default maxWords=220 must stay in
// exactly one chunk. Regression guard: old code broke this when maxChars dominated.
// Coverage: unit (no model).
test('100 short English words with default chunker produce exactly 1 chunk', () => {
  const defaultChunker = new ParagraphChunker()
  const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
  const chunks = defaultChunker.chunk({ pageId: 'p1', text })
  expect(chunks.length).toBe(1)
})

// Scenario: A long spaceless ASCII token must not create a giant chunk that exceeds
// the embedder's token limit.
// Coverage: unit (no model; verifies pure chunking logic).
test('hard-splits a long spaceless ASCII token into maxCharsPerWord slices', () => {
  const longWord = 'a'.repeat(1000)
  const smallChunker = new ParagraphChunker(220, 100)
  const chunks = smallChunker.chunk({ pageId: 'p1', text: longWord })
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) {
    expect(c.text.length).toBeLessThanOrEqual(100)
  }
  // Slices must reconstruct the original without gaps or duplication.
  expect(chunks.map((c) => c.text).join('')).toBe(longWord)
})

// Non-ASCII allowed here: verifying CJK spaceless text is bounded by code-point budget.
// Scenario: A spaceless Japanese/Chinese string longer than maxCharsPerWord must be
// hard-split so each chunk is within the code-point limit.
// Coverage: unit (no model; pure logic).
test('hard-splits CJK spaceless text into multiple chunks', () => {
  const cjkText = 'コルチゾールは睡眠を料害するホルモンです'
  // 20 CJK code points, maxCharsPerWord=10 => should split into >=2 chunks
  const smallChunker = new ParagraphChunker(220, 10)
  const chunks = smallChunker.chunk({ pageId: 'p1', text: cjkText })
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) {
    expect([...c.text].length).toBeLessThanOrEqual(10)
  }
})

// Non-ASCII allowed here: verifying surrogate pairs (emoji) are never split mid-character.
// Scenario: A spaceless emoji string sliced naively by UTF-16 index would corrupt surrogates;
// code-point slicing must round-trip perfectly.
// Coverage: unit (no model; pure chunking logic).
test('surrogate pairs are never split: emoji run round-trips through chunking', () => {
  // Each fire emoji is U+1F525, which encodes as 2 UTF-16 code units but 1 code point.
  const original = '\u{1F525}'.repeat(12) // 12 emoji = 12 code points = 24 UTF-16 units
  const smallChunker = new ParagraphChunker(220, 3) // max 3 code points per hard-split slice
  const chunks = smallChunker.chunk({ pageId: 'p1', text: original })

  // Must have been split into multiple chunks.
  expect(chunks.length).toBeGreaterThan(1)

  const joined = chunks.map((c) => c.text).join('')
  // Code-point count must be preserved (no replacement chars introduced).
  expect(Array.from(joined).length).toBe(Array.from(original).length)
  // Full string must be reconstructed exactly.
  expect(joined).toBe(original)
})

// Scenario: A page with 300 short paragraphs (the real-world 369-chunk bug) must NOT
// produce one chunk per paragraph. With word-stream merging, 300 x 3-word paragraphs
// (900 words total) should yield ceil(900/220) = 5 chunks, NOT 300.
// Coverage: unit  -  regression guard for the performance bug.
test('count-reduction: 300 short paragraphs collapse to ~5 chunks, not 300', () => {
  const defaultChunker = new ParagraphChunker()
  // Each paragraph: "para number N" = 3 words. 300 paragraphs = 900 words total.
  const text = Array.from({ length: 300 }, (_, i) => `para number ${i}`).join('\n\n')
  const chunks = defaultChunker.chunk({ pageId: 'p1', text })

  // 900 words / 220 maxWords = ceil = 5 chunks (maybe 5 with a remainder chunk).
  const expectedApprox = Math.ceil(900 / 220) // 5
  expect(chunks.length).toBeLessThanOrEqual(6)
  expect(chunks.length).toBe(expectedApprox) // should be exactly 5
  // Definitely NOT 300 (old behavior).
  expect(chunks.length).toBeLessThan(10)
})

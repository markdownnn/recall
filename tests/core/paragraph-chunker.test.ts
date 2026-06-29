import { ParagraphChunker } from '../../src/core/paragraph-chunker'

const chunker = new ParagraphChunker(5) // maxWords=5 for testing

test('splits on blank lines into chunks', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'first para\n\nsecond para' })
  expect(chunks.map((c) => c.text)).toEqual(['first para', 'second para'])
})

test('assigns stable ids and indices', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'a\n\nb' })
  expect(chunks[0]).toMatchObject({ id: 'p1#0', pageId: 'p1', index: 0 })
  expect(chunks[1]).toMatchObject({ id: 'p1#1', index: 1 })
})

test('splits a paragraph longer than maxWords', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'one two three four five six seven' })
  expect(chunks.length).toBe(2)
  expect(chunks[0].text).toBe('one two three four five')
  expect(chunks[1].text).toBe('six seven')
})

test('ignores empty paragraphs', () => {
  const chunks = chunker.chunk({ pageId: 'p1', text: 'a\n\n\n\n  \n\nb' })
  expect(chunks.map((c) => c.text)).toEqual(['a', 'b'])
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
  expect(chunks.map((c) => c.text).join('')).toBe(longWord)
})

// Scenario: 100 short English words must stay in one chunk with the default constructor,
// locking the regression where maxChars dominated and shrank English chunks too early.
// Coverage: unit (no model).
test('100 short English words with default chunker produce exactly 1 chunk', () => {
  const defaultChunker = new ParagraphChunker()
  const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
  const chunks = defaultChunker.chunk({ pageId: 'p1', text })
  expect(chunks.length).toBe(1)
})

// Non-ASCII allowed here: verifying CJK spaceless text is bounded by code-point budget.
test('hard-splits CJK spaceless text into multiple chunks', () => {
  const cjkText = 'コルチゾールは睡眠を妖害するホルモンです'
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

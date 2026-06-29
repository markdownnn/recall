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

test('hard-splits a long spaceless ASCII token into maxChars slices', () => {
  const longWord = 'a'.repeat(1000)
  const smallChunker = new ParagraphChunker(220, 100)
  const chunks = smallChunker.chunk({ pageId: 'p1', text: longWord })
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) {
    expect(c.text.length).toBeLessThanOrEqual(100)
  }
  expect(chunks.map((c) => c.text).join('')).toBe(longWord)
})

// Non-ASCII allowed here: verifying CJK spaceless text is bounded by char budget.
test('hard-splits CJK spaceless text into multiple chunks', () => {
  const cjkText = 'コルチゾールは睡眠を妖害するホルモンです'
  const smallChunker = new ParagraphChunker(220, 10)
  const chunks = smallChunker.chunk({ pageId: 'p1', text: cjkText })
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) {
    expect([...c.text].length).toBeLessThanOrEqual(10)
  }
})

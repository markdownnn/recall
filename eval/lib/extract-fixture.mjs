// Dev helper (run by build-corpus.mjs): turn a fetched page into block-joined text.
// Block-joined = one block-level element per line, so section headings (References, See
// also, ...) land on their OWN line - which is what stripBoilerplate keys on, and what
// production extract() will emit. References/boilerplate are KEPT (pre-strip) on purpose.
import { parseHTML } from 'linkedom'

const UA = 'recall-eval-harness/1.0 (https://github.com/; offline golden-set fixtures)'
const BLOCK_SEL = 'h1,h2,h3,h4,h5,p,li,blockquote,pre,dd,dt'

export async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

// Join the block elements under `root` into one-block-per-line text.
function blockJoin(root) {
  const blocks = [...root.querySelectorAll(BLOCK_SEL)]
  return blocks
    .map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

// Wikimedia REST (Wikipedia / Wikinews) Parsoid HTML: clean article content with real
// <h2 id="References">References</h2> headings and <li> citation rows. Drop figure/table
// captions and the mw edit-section noise.
export function extractWikimedia(html) {
  const { document } = parseHTML(html)
  for (const sel of ['style', 'sup.mw-ref', 'figure', 'table', '.mw-editsection']) {
    for (const el of document.querySelectorAll(sel)) el.remove()
  }
  const body = document.querySelector('body') ?? document
  return blockJoin(body)
}

// MDN index.json: doc.title + doc.body[] (each section has value.content HTML or value
// scalar). Concatenate the section HTML, then block-join.
export function extractMdn(json) {
  const doc = json.doc ?? {}
  const htmlParts = []
  for (const sec of doc.body ?? []) {
    const v = sec.value
    if (v && typeof v.content === 'string') htmlParts.push(v.content)
  }
  const { document } = parseHTML(`<body>${htmlParts.join('\n')}</body>`)
  for (const el of document.querySelectorAll('table,.code-example,pre.brush\\:')) el.remove()
  const text = blockJoin(document.querySelector('body') ?? document)
  return doc.title ? `${doc.title}\n${text}` : text
}

// Generic HTML (blogs): pick the densest content root (article/main, else the element
// holding the most <p>), then block-join. Strips nav/aside/footer first.
export function extractGeneric(html) {
  const { document } = parseHTML(html)
  for (const el of document.querySelectorAll('nav,aside,footer,header,script,style,form,noscript'))
    el.remove()
  let root = document.querySelector('article') || document.querySelector('main')
  if (!root) {
    let best = document.querySelector('body') ?? document
    let bestCount = -1
    for (const el of document.querySelectorAll('div,section,article,main')) {
      const c = el.querySelectorAll('p').length
      if (c > bestCount) {
        bestCount = c
        best = el
      }
    }
    root = best
  }
  return blockJoin(root)
}

// GitHub issue/PR via the API: title + markdown body, already one-thought-per-line.
export function extractGithub(issue) {
  const title = issue.title ?? ''
  const body = (issue.body ?? '').replace(/\r\n/g, '\n')
  return `${title}\n${body}`.trim()
}

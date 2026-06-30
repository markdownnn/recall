// Dev helper (NOT a build step). Run by hand to (re)produce the golden-set corpus:
//   vite-node eval/lib/build-corpus.mjs
// Fetches each source page, extracts block-joined text (references KEPT), writes
// eval/fixtures/<id>.txt, and writes eval/manifest.json with the provenance + the
// pageIdFromUrl(url) that the harness will store under (so expectTopPageIds matches).
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pageIdFromUrl } from '../../src/core/capture-service.ts'
import {
  fetchText,
  extractWikimedia,
  extractMdn,
  extractGeneric,
  extractGithub,
} from './extract-fixture.mjs'

const FIX_DIR = resolve('eval/fixtures')
mkdirSync(FIX_DIR, { recursive: true })

// `title` is the RAW (un-encoded) article title; encode exactly once for the REST call
// and let pageIdFromUrl encode the /wiki/ url. Double-encoding 403s on Wikimedia.
const wikimedia = (host, title, file, note, lang) => ({
  type: 'wikimedia',
  file,
  lang,
  source: host.includes('wikinews') ? 'Wikinews' : lang === 'ko' ? 'Korean Wikipedia' : 'Wikipedia',
  url: `https://${host}/wiki/${title}`,
  rest: `https://${host}/api/rest_v1/page/html/${encodeURIComponent(title)}`,
  note,
})
const wiki = (title, file, note, lang = 'en') =>
  wikimedia(`${lang}.wikipedia.org`, title, file, note, lang)
// Wikinews REST is 404; fetch parsed HTML via the action API by stable pageid instead.
const news = (title, pageid, file, note) => ({
  type: 'wikinews',
  file,
  lang: 'en',
  source: 'Wikinews',
  url: `https://en.wikinews.org/wiki/${title}`,
  api: `https://en.wikinews.org/w/api.php?action=parse&pageid=${pageid}&prop=text&format=json`,
  note,
})

const PAGES = [
  // --- Reference-heavy English Wikipedia (the citation-pollution cases) ---
  wiki('Bacteria', 'wiki-bacteria.txt', 'reference-heavy; S1 target'),
  wiki('Protein', 'wiki-protein.txt', "contains a 'Protein digestion' reference chunk -> S2 false-positive risk; S5 target"),
  wiki('Deep_learning', 'wiki-deep-learning.txt', 'reference-heavy; observed failure'),
  wiki('Photosynthesis', 'wiki-photosynthesis.txt', 'S3 cross-lingual target'),
  wiki('Cortisol', 'wiki-cortisol.txt', 'S4 paraphrase target (hormone that ruins sleep)'),
  wiki('Mitochondrion', 'wiki-mitochondrion.txt', 'reference-heavy'),
  wiki('Sleep', 'wiki-sleep.txt', 'reference-heavy'),
  wiki('Immune_system', 'wiki-immune-system.txt', 'reference-heavy'),
  wiki('DNA', 'wiki-dna.txt', 'reference-heavy'),
  wiki('Cell_(biology)', 'wiki-cell.txt', 'reference-heavy'),
  // --- Korean Wikipedia (cross-lingual corpus presence) ---
  wiki('인공지능', 'ko-ai.txt', 'Korean article: artificial intelligence', 'ko'),
  wiki('김치', 'ko-kimchi.txt', 'Korean article: kimchi', 'ko'),
  wiki('한글', 'ko-hangul.txt', 'Korean article: Hangul', 'ko'),
  wiki('태양', 'ko-sun.txt', 'Korean article: the Sun', 'ko'),
  wiki('대한민국', 'ko-korea.txt', 'Korean article: Republic of Korea', 'ko'),
  // --- News (Wikinews: real news with byline/source/category boilerplate) ---
  news('Wikimedia_Foundation_closes_Wikinews_after_21_years', 3088290, 'news-wikinews.txt', 'news article'),
  news('Pope_Leo_XIV_visits_four_nations_in_Africa', 3093065, 'news-pope.txt', 'news article'),
  news('United_States_announces_blockade_on_the_Strait_of_Hormuz', 3091494, 'news-hormuz.txt', 'news article'),
  // --- Docs (MDN) ---
  {
    type: 'mdn',
    file: 'mdn-array.txt',
    lang: 'en',
    source: 'MDN',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
    rest: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/index.json',
    note: 'docs page; non-wiki boilerplate shape',
  },
  {
    type: 'mdn',
    file: 'mdn-promise.txt',
    lang: 'en',
    source: 'MDN',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise',
    rest: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/index.json',
    note: 'docs page',
  },
  {
    type: 'mdn',
    file: 'mdn-fetch.txt',
    lang: 'en',
    source: 'MDN',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch',
    rest: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch/index.json',
    note: 'docs page',
  },
  // --- Blogs (static long-form prose; non-wiki boilerplate shape) ---
  { type: 'generic', file: 'blog-ds.txt', lang: 'en', source: 'Blog (paulgraham.com)', url: 'https://paulgraham.com/ds.html', note: 'long-form blog' },
  { type: 'generic', file: 'blog-startupideas.txt', lang: 'en', source: 'Blog (paulgraham.com)', url: 'https://paulgraham.com/startupideas.html', note: 'long-form blog' },
  { type: 'generic', file: 'blog-strace.txt', lang: 'en', source: 'Blog (jvns.ca)', url: 'https://jvns.ca/blog/2021/04/03/what-problems-do-people-solve-with-strace/', note: 'tech blog' },
  { type: 'generic', file: 'blog-cli-tools.txt', lang: 'en', source: 'Blog (jvns.ca)', url: 'https://jvns.ca/blog/2022/04/12/a-list-of-new-ish--command-line-tools/', note: 'tech blog' },
  // --- GitHub (the real ingestion case + one decoy) ---
  {
    type: 'github',
    file: 'gh-ingestion.txt',
    lang: 'en',
    source: 'GitHub',
    url: 'https://github.com/hashicorp/terraform-provider-aws/issues/31364',
    api: 'repos/hashicorp/terraform-provider-aws/issues/31364',
    note: "REAL failing case: literally about 'ingestion' -> S2 target",
  },
  {
    type: 'github',
    file: 'gh-k8s-migration.txt',
    lang: 'en',
    source: 'GitHub',
    url: 'https://github.com/kubernetes/kubernetes/issues/135178',
    api: 'repos/kubernetes/kubernetes/issues/135178',
    note: 'GitHub issue decoy (no ingestion term)',
  },
]

async function extractOne(p) {
  if (p.type === 'wikimedia') return extractWikimedia(await fetchText(p.rest))
  if (p.type === 'wikinews') {
    const json = JSON.parse(await fetchText(p.api))
    return extractWikimedia(`<body>${json?.parse?.text?.['*'] ?? ''}</body>`)
  }
  if (p.type === 'mdn') return extractMdn(JSON.parse(await fetchText(p.rest)))
  if (p.type === 'generic') return extractGeneric(await fetchText(p.url))
  if (p.type === 'github') {
    const out = execFileSync('gh', ['api', p.api], { encoding: 'utf8', maxBuffer: 1e8 })
    return extractGithub(JSON.parse(out))
  }
  throw new Error(`unknown type ${p.type}`)
}

const manifest = []
for (const p of PAGES) {
  try {
    const text = await extractOne(p)
    if (!text || text.length < 200) {
      console.warn(`SKIP ${p.file}: only ${text?.length ?? 0} chars`)
      continue
    }
    writeFileSync(resolve(FIX_DIR, p.file), text + '\n')
    const id = pageIdFromUrl(p.url)
    manifest.push({ id, file: p.file, url: p.url, source: p.source, lang: p.lang, note: p.note })
    console.log(`OK   ${p.file.padEnd(26)} ${String(text.length).padStart(7)} chars  id=${id}`)
  } catch (e) {
    console.warn(`FAIL ${p.file}: ${e.message}`)
  }
}

writeFileSync(resolve('eval/manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`\nwrote eval/manifest.json with ${manifest.length} rows`)
console.log('\n--- pageIdFromUrl for golden targets ---')
for (const p of PAGES) console.log(`${p.file}: ${pageIdFromUrl(p.url)}`)

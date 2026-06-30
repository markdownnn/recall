// Golden-set harness runner.
// Usage: vite-node eval/run.mjs [--strip] [--min-prose=0.35] [--ci]
// Prints a per-query + per-scenario scorecard and writes eval/last-scorecard.json.
import { readFileSync, writeFileSync } from 'node:fs'
import { buildStore, runQuery } from './lib/build-and-search.mjs'
import { proseScore } from '../src/core/prose-score.ts'
import {
  precisionAt1,
  recallAtK,
  mrr,
  referenceSnippetRate,
  aggregate,
} from '../src/core/eval-metrics.ts'

const args = process.argv.slice(2)
const strip = args.includes('--strip')
const ci = args.includes('--ci')
const minProse = Number(args.find((a) => a.startsWith('--min-prose='))?.split('=')[1] ?? 0)
const TAU = 0.35 // prose threshold for "is this snippet a citation list?"
const K = 5

const manifest = JSON.parse(readFileSync('eval/manifest.json', 'utf8'))
const golden = JSON.parse(readFileSync(ci ? 'eval/ci-golden.json' : 'eval/golden.json', 'utf8'))

console.log(
  `[eval] corpus=${manifest.length} pages  queries=${golden.length}  ` +
    `strip=${strip}  minProse=${minProse}  ci=${ci}`,
)
const t0 = Date.now()
const store = await buildStore(manifest, { strip, minProse })
console.log(`[eval] indexed + embedded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)

const rows = []
for (const g of golden) {
  const results = await runQuery(store, g.query, K)
  const rankedPageIds = results.map((r) => r.page.id)
  const topSnippet = results[0]?.chunk.text ?? ''
  const topIsProse = results.length > 0 && proseScore(topSnippet) >= TAU
  rows.push({
    scenario: g.scenario,
    query: g.query,
    topPage: rankedPageIds[0] ?? '(none)',
    p1: precisionAt1(rankedPageIds, g.expectTopPageIds),
    r5: recallAtK(rankedPageIds, g.expectTopPageIds, K),
    rr: mrr(rankedPageIds, g.expectTopPageIds),
    topIsProse,
  })
}

const agg = aggregate(rows)
const refRate = referenceSnippetRate(rows)

console.log('SCEN  P@1  R@5  RR    refProse  query -> topPage')
for (const r of rows) {
  console.log(
    `${r.scenario.padEnd(5)} ${r.p1}    ${r.r5}    ${r.rr.toFixed(2)}  ` +
      `${r.topIsProse ? 'prose ' : 'CITE! '}  ${r.query} -> ${r.topPage}`,
  )
}
console.log('---')
console.log(
  `P@1=${agg.precisionAt1.toFixed(2)}  recall@5=${agg.recallAt5.toFixed(2)}  ` +
    `MRR=${agg.mrr.toFixed(2)}  reference-snippet-rate=${refRate.toFixed(2)}`,
)

writeFileSync(
  'eval/last-scorecard.json',
  JSON.stringify({ strip, minProse, ci, agg, refRate, rows }, null, 2) + '\n',
)

if (ci) {
  const fail = []
  if (refRate !== 0) fail.push(`reference-snippet-rate ${refRate} != 0`)
  if (agg.precisionAt1 < 0.8) fail.push(`p@1 ${agg.precisionAt1} < 0.8`)
  const s2 = rows.find((r) => r.scenario === 'S2')
  if (!s2 || s2.p1 !== 1) fail.push('S2 (exact-term) did not pass')
  if (fail.length) {
    console.error('\nEVAL CI FAILED:\n' + fail.join('\n'))
    process.exit(1)
  }
  console.log('\nEVAL CI PASSED')
}

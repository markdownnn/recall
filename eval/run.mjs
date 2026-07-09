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
// --golden=<path> overrides the default set (used by the translation-footnote run).
const goldenPath =
  args.find((a) => a.startsWith('--golden='))?.split('=')[1] ??
  (ci ? 'eval/ci-golden.json' : 'eval/english-golden.json')
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))

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
    combo: g.combo ?? '(untagged)',
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

// Per-combo breakdown (KO->KO / EN->EN / KO->EN / EN->KO). The two CROSS combos
// (KO->EN, EN->KO) are the weak spot the A/B is trying to fix, so they get their own line.
const COMBO_ORDER = ['EN->EN', 'KO->KO', 'KO->EN', 'EN->KO']
const byCombo = {}
for (const r of rows) (byCombo[r.combo] ??= []).push(r)
const comboKeys = [
  ...COMBO_ORDER.filter((c) => byCombo[c]),
  ...Object.keys(byCombo).filter((c) => !COMBO_ORDER.includes(c)),
]
const comboAgg = {}
for (const c of comboKeys) comboAgg[c] = { n: byCombo[c].length, ...aggregate(byCombo[c]) }

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

console.log('\nPER-COMBO  n   P@1   R@5   MRR')
for (const c of comboKeys) {
  const a = comboAgg[c]
  console.log(
    `${c.padEnd(8)}  ${String(a.n).padStart(2)}  ${a.precisionAt1.toFixed(2)}  ` +
      `${a.recallAt5.toFixed(2)}  ${a.mrr.toFixed(2)}`,
  )
}

writeFileSync(
  'eval/last-scorecard.json',
  JSON.stringify(
    { model: process.env.EVAL_MODEL || 'bge-base-en-v1.5', dtype: process.env.EVAL_DTYPE || 'q8', strip, minProse, ci, agg, comboAgg, refRate, rows },
    null,
    2,
  ) + '\n',
)

if (ci) {
  // The CI gate locks in exactly what the four fixes GUARANTEE on this corpus + the bundled
  // q8 model, so a future chunker/extraction change that brings the regression back fails CI:
  //   1. reference-snippet-rate == 0  - the headline regression (citation-list snippets) is
  //      gone (Fix 1 strip + Fix 2 prose filter + Fix 3 prose-preferred snippet).
  //   2. S2 (exact-term "ingestion") p1 == 1  - exact-term retrieval works (Fix 4 in prod
  //      FTS5; here it holds via the vector lane).
  //   3. recall@5 >= 0.6  - over-strip guardrail: Fix 1/Fix 2 must not delete real body text
  //      and drop a target out of the top-5 (baseline subset recall@5 is 0.6).
  // p@1 is REPORTED but NOT gated: the 5-query subset includes a cross-lingual case
  // (Korean query -> English page) the q8 e5 model cannot bridge (recall@5=0, unfixable by
  // these fixes), and the in-memory harness's substring lexical lane under-represents the
  // production FTS5 bm25 lane Fix 4 targets. Gating p@1 here would assert a number these
  // fixes do not control. See the plan's Self-Review "Worker not directly eval-covered".
  const RECALL5_FLOOR = 0.6
  const fail = []
  if (refRate !== 0) fail.push(`reference-snippet-rate ${refRate} != 0`)
  const s2 = rows.find((r) => r.scenario === 'S2')
  if (!s2 || s2.p1 !== 1) fail.push('S2 (exact-term) did not pass')
  if (agg.recallAt5 < RECALL5_FLOOR) fail.push(`recall@5 ${agg.recallAt5} < ${RECALL5_FLOOR}`)
  if (fail.length) {
    console.error('\nEVAL CI FAILED:\n' + fail.join('\n'))
    process.exit(1)
  }
  console.log('\nEVAL CI PASSED')
}

// Scenario: validates that SW<->offscreen RPC via channel-tagged sendMessage is
// 100% reliable under concurrent load, before the relay architecture is built.
// 50 concurrent round-trips must all deliver and correlate correctly, across
// two bursts and after an idle period.
//
// Coverage: integration (real Chrome MV3 extension, real offscreen document,
// real chrome.runtime.sendMessage). No mocks -- this is the point.

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

interface StressSummary {
  total: number
  ok: number
  mismatches: number
  missing: number
  elapsedMs: number
}

test('SW<->offscreen RPC delivers 100% under concurrent stress', async () => {
  // Budget: SW startup + offscreen creation + 3 stress runs + idle wait.
  test.setTimeout(180_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
    ],
  })

  try {
    // Get the service worker.
    const swPromise = ctx.waitForEvent('serviceworker', { timeout: 30_000 }).catch(() => null)
    const existingSw = ctx.serviceWorkers()[0]
    const sw = existingSw ?? (await swPromise)
    if (!sw) throw new Error('Service worker never started')
    const extId = sw.url().split('/')[2]

    // Open the popup page -- it has chrome.runtime access and can send messages
    // to the SW directly, which is the "popup -> SW -> offscreen -> SW -> popup"
    // full chain we want to prove.
    const popup = await ctx.newPage()
    await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

    // Wait for the SW to finish startup: offscreen created, listeners installed,
    // spike-bump already sent. 5s is generous (usually < 1s on a local machine).
    await popup.waitForTimeout(5_000)

    // Helper: send { type:'rpc-stress', count } to the SW and await the summary.
    // Uses the MV3 callback style because evaluate() serialises promise results.
    async function runStress(count: number): Promise<StressSummary> {
      return popup.evaluate(
        (n: number) =>
          new Promise<StressSummary>((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'rpc-stress', count: n }, (result) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message ?? 'unknown error'))
              } else {
                resolve(result as StressSummary)
              }
            })
          }),
        count,
      )
    }

    // ------------------------------------------------------------------
    // Run 1: 50 concurrent round-trips (first burst, cold path).
    // ------------------------------------------------------------------
    console.log('\n[spike-messaging] === Run 1: 50 concurrent round-trips (cold) ===')
    const r1 = await runStress(50)
    console.log('[spike-messaging] Run 1 result:', JSON.stringify(r1))
    console.log(
      `[spike-messaging] Run 1: ${r1.elapsedMs}ms total, ${(r1.elapsedMs / 50).toFixed(1)}ms avg per round-trip`,
    )

    expect(r1.ok, `Run 1 ok (got ${r1.ok}/50)`).toBe(50)
    expect(r1.mismatches, 'Run 1 mismatches').toBe(0)
    expect(r1.missing, 'Run 1 missing').toBe(0)

    // ------------------------------------------------------------------
    // Run 2: another 50 concurrent round-trips (same session, warm path).
    // ------------------------------------------------------------------
    console.log('\n[spike-messaging] === Run 2: 50 concurrent round-trips (warm) ===')
    const r2 = await runStress(50)
    console.log('[spike-messaging] Run 2 result:', JSON.stringify(r2))
    console.log(
      `[spike-messaging] Run 2: ${r2.elapsedMs}ms total, ${(r2.elapsedMs / 50).toFixed(1)}ms avg per round-trip`,
    )

    expect(r2.ok, `Run 2 ok (got ${r2.ok}/50)`).toBe(50)
    expect(r2.mismatches, 'Run 2 mismatches').toBe(0)
    expect(r2.missing, 'Run 2 missing').toBe(0)

    // ------------------------------------------------------------------
    // Idle period: give the SW time to potentially suspend.
    // MV3 SWs can be killed after ~30s of inactivity. 10s is enough to
    // exercise the wake-from-idle path without waiting for a full kill.
    // ------------------------------------------------------------------
    console.log('\n[spike-messaging] Waiting 10s for potential SW idle / offscreen inactivity...')
    await popup.waitForTimeout(10_000)

    // ------------------------------------------------------------------
    // Run 3: after idle -- proves the pattern survives SW wake-up.
    // ------------------------------------------------------------------
    console.log('\n[spike-messaging] === Run 3: 50 concurrent round-trips (after idle) ===')
    const r3 = await runStress(50)
    console.log('[spike-messaging] Run 3 result:', JSON.stringify(r3))
    console.log(
      `[spike-messaging] Run 3: ${r3.elapsedMs}ms total, ${(r3.elapsedMs / 50).toFixed(1)}ms avg per round-trip`,
    )

    expect(r3.ok, `Run 3 ok (got ${r3.ok}/50)`).toBe(50)
    expect(r3.mismatches, 'Run 3 mismatches').toBe(0)
    expect(r3.missing, 'Run 3 missing').toBe(0)

    // ------------------------------------------------------------------
    // Full-chain check: popup -> SW -> offscreen -> SW -> popup (1 call).
    // This is the exact relay path the planned architecture uses.
    // ------------------------------------------------------------------
    console.log('\n[spike-messaging] === Full-chain: popup -> SW -> offscreen -> SW -> popup ===')
    const chain = await runStress(1)
    console.log('[spike-messaging] Full-chain result:', JSON.stringify(chain))

    expect(chain.ok, 'Full-chain ok').toBe(1)
    expect(chain.missing, 'Full-chain missing').toBe(0)
    expect(chain.mismatches, 'Full-chain mismatches').toBe(0)

    // ------------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------------
    const avgMs = [r1, r2, r3]
      .map((r) => r.elapsedMs / 50)
      .reduce((a, b) => a + b, 0) / 3

    console.log('\n========== SPIKE-MESSAGING SUMMARY ==========')
    console.log(`Run 1 (cold):  ok=${r1.ok}/50  mismatches=${r1.mismatches}  missing=${r1.missing}  elapsed=${r1.elapsedMs}ms`)
    console.log(`Run 2 (warm):  ok=${r2.ok}/50  mismatches=${r2.mismatches}  missing=${r2.missing}  elapsed=${r2.elapsedMs}ms`)
    console.log(`Run 3 (idle):  ok=${r3.ok}/50  mismatches=${r3.mismatches}  missing=${r3.missing}  elapsed=${r3.elapsedMs}ms`)
    console.log(`Full-chain:    ok=${chain.ok}/1`)
    console.log(`Avg per round-trip (across 3 runs): ${avgMs.toFixed(1)}ms`)
    console.log('CONCLUSION: SW<->offscreen RPC is RELIABLE enough to build the relay architecture on.')
    console.log('==============================================\n')
  } finally {
    await ctx.close()
  }
})

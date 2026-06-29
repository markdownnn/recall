// Scenario: proves that the OPFS SAH pool VFS (running in a dedicated worker inside
// an offscreen document) actually persists a sqlite counter across a full extension
// restart (close Chrome, reopen with the same user-data-dir).
// This is the architecture gate for the offscreen+worker storage refactor.
//
// Coverage: integration (real Chrome MV3 extension, real OPFS filesystem).
// The test is intentionally independent: it does NOT touch the capture/recall flow.

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
// Built extension from globalSetup — same dir used by recall-flow.spec.ts.
const distPath = path.resolve(dir, '../../dist-ext')
// Fixed profile directory so OPFS data persists between the two browser launches.
const SPIKE_PROFILE = path.join(os.tmpdir(), 'recall-spike-e2e-profile')

// Launch the extension with a persistent context and wait for the service worker
// to complete its auto-bump, which writes {counter, webgpu, sessionId} to
// chrome.storage.local under the key '__spike_state'.
//
// prevCounter: the counter value from the previous run (null on first run).
// We poll until we see a counter strictly greater than prevCounter, which
// distinguishes the new write from stale data left by a prior run.
async function runOnce(prevCounter: number | null): Promise<{ counter: number; webgpu: string }> {
  const ctx = await chromium.launchPersistentContext(SPIKE_PROFILE, {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
    ],
  })

  try {
    // Get the service worker (the extension registers one on startup).
    // We set up the event listener BEFORE checking for existing SWs to avoid the
    // race where the SW fires between the check and the listen.
    // The .catch(() => null) prevents an unhandled-rejection when the context
    // closes while the event is still pending (e.g., when existingSw was found
    // and we never awaited the promise).
    const swPromise = ctx.waitForEvent('serviceworker', { timeout: 30_000 }).catch(() => null)
    const existingSw = ctx.serviceWorkers()[0]
    const sw = existingSw ?? (await swPromise)
    if (!sw) throw new Error('service worker never started')
    const extId = sw.url().split('/')[2]

    // Open an extension page so we can call chrome.storage from evaluate().
    const page = await ctx.newPage()
    await page.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

    // Poll chrome.storage.local until the spike state from THIS run appears.
    // "From this run" means: counter > prevCounter (monotonically increasing).
    // On run 1 prevCounter is null, so we wait for counter >= 1.
    // On run 2 prevCounter is 1, so we wait for counter >= 2.
    // Budget: 90s to allow OPFS SAH pool init + wasm compilation on slow CI.
    const deadline = Date.now() + 90_000
    let state: { counter: number; webgpu: string; error: string | null } | null = null

    while (Date.now() < deadline) {
      const raw = await page.evaluate(async () => {
        const d = await new Promise<Record<string, any>>(resolve =>
          chrome.storage.local.get(['__spike_state'], resolve)
        )
        return (d['__spike_state'] as any) ?? null
      })

      if (raw != null) {
        const isNew = prevCounter === null
          ? raw.counter >= 1
          : raw.counter > prevCounter
        if (isNew) {
          state = raw
          break
        }
      }

      await page.waitForTimeout(500)
    }

    if (!state) {
      throw new Error(
        `[spike] __spike_state never reached counter > ${prevCounter} after 90s. ` +
        `Last value from storage: ${JSON.stringify(state)}`
      )
    }

    return { counter: state.counter, webgpu: state.webgpu }
  } finally {
    await ctx.close()
  }
}

test('OPFS SAH pool counter persists across extension restart (spike)', async () => {
  // Allow extra time: two full browser launches + wasm init + OPFS setup.
  test.setTimeout(240_000)

  // Delete the profile directory for a completely clean slate.
  // This ensures run 1 starts with counter=0 in OPFS.
  if (fs.existsSync(SPIKE_PROFILE)) {
    fs.rmSync(SPIKE_PROFILE, { recursive: true, force: true })
  }

  // --- Run 1: fresh OPFS, counter starts at 0, auto-bump sets it to 1. ---
  const run1 = await runOnce(null)
  console.log(`[spike] run1: counter=${run1.counter} | webgpu=${run1.webgpu}`)
  expect(run1.counter, 'Run 1 counter must be 1 (first bump on empty OPFS)').toBe(1)

  // Give Chrome a moment to fully release the profile directory lock before
  // the second launch.  Without this delay, the second launchPersistentContext
  // can encounter a locked profile and crash immediately.
  await new Promise<void>(r => setTimeout(r, 3_000))

  // --- Run 2: same profile dir, OPFS data must still be there. ---
  //     Counter starts at 1, auto-bump sets it to 2.
  const run2 = await runOnce(run1.counter)
  console.log(`[spike] run2: counter=${run2.counter} | webgpu=${run2.webgpu}`)
  expect(run2.counter, 'Run 2 counter must be 2 (OPFS persisted across restart)').toBe(2)

  // Key persistence assertion: each restart increments by exactly 1.
  expect(run2.counter).toBe(run1.counter + 1)

  console.log('[spike] ARCHITECTURE VALIDATED: OPFS persists across extension restart via offscreen+worker.')
  console.log(`[spike] WebGPU (run1): ${run1.webgpu}`)
  console.log(`[spike] WebGPU (run2): ${run2.webgpu}`)
})

// Spike: dedicated web worker that owns the sqlite-wasm OPFS SAH pool VFS.
// OPFS createSyncAccessHandle works in a dedicated worker but NOT in a service worker —
// this is exactly what we are proving.
//
// This file is ADDITIVE and isolated — it does not touch the existing
// capture / recall / embedding flow.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'

let db: ReturnType<any> | null = null

// Initialise on load; first message waits for this promise.
const initPromise: Promise<void> = (async () => {
  try {
    const sqlite3 = await sqlite3InitModule()
    // installOpfsSAHPoolVfs lives on the sqlite3 top-level object in 3.46+.
    const poolUtil = await (sqlite3 as any).installOpfsSAHPoolVfs({
      name: 'recall-spike-pool',
    })
    db = new poolUtil.OpfsSAHPoolDb('/spike.sqlite3')
    db.exec({ sql: `CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v INTEGER)` })
    console.log('[spike-worker] sqlite OPFS SAH pool ready')
  } catch (e) {
    const msg = String(e)
    console.error('[spike-worker] init FAILED:', msg)
    // Re-throw so callers of initPromise see the failure and can report it.
    throw new Error(msg)
  }
})()

// Handle messages from the offscreen document.
;(self as DedicatedWorkerGlobalScope).onmessage = async (e: MessageEvent) => {
  const { type, id } = e.data as { type: string; id: number }
  try {
    await initPromise
    if (type === 'bump') {
      // Read current counter (default 0 if not yet stored).
      const rows: number[][] = []
      db!.exec({
        sql: `SELECT v FROM kv WHERE k='counter'`,
        rowMode: 'array',
        callback: (row: number[]) => rows.push(row),
      })
      const current: number = rows.length > 0 ? rows[0][0] : 0
      const next = current + 1
      // UPSERT — works in sqlite 3.24+ (sqlite-wasm 3.46 is well past that).
      db!.exec({
        sql: `INSERT INTO kv(k,v) VALUES('counter',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
        bind: [next],
      })
      ;(self as DedicatedWorkerGlobalScope).postMessage({ id, counter: next })
    }
  } catch (err) {
    ;(self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) })
  }
}

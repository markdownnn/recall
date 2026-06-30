import { SqliteWorkerClient } from '../../src/offscreen/sqlite-worker-client'

function fakeWorker() {
  const w: any = { posted: [], onmessage: null, onerror: null,
    postMessage(m: any) { this.posted.push(m) } }
  return w
}

test('request resolves with the matching reply', async () => {
  const w = fakeWorker()
  const c = new SqliteWorkerClient(w)
  const p = c.request('getSettings')
  const id = w.posted[0].id
  w.onmessage({ data: { id, result: { paused: true } } })
  await expect(p).resolves.toEqual({ paused: true })
})

test('worker error rejects only the matching call', async () => {
  const w = fakeWorker()
  const c = new SqliteWorkerClient(w)
  const a = c.request('a'); const b = c.request('b')
  w.onmessage({ data: { id: w.posted[0].id, error: 'boom' } })
  await expect(a).rejects.toThrow('boom')
  w.onmessage({ data: { id: w.posted[1].id, result: 1 } })
  await expect(b).resolves.toBe(1)
})

test('worker onerror rejects all in-flight calls', async () => {
  const w = fakeWorker()
  const c = new SqliteWorkerClient(w)
  const a = c.request('a'); const b = c.request('b')
  w.onerror(new Error('crash'))
  await expect(a).rejects.toBeTruthy()
  await expect(b).rejects.toBeTruthy()
})

// Scenario: a hung worker must not block the caller indefinitely; the pending
// Map entry must be cleaned up so a late reply arriving after the timeout is
// silently ignored rather than crashing.
// Coverage: integration (real setTimeout; no fake timers needed for 10ms).
test('per-call timeout rejects when no reply arrives', async () => {
  const w = fakeWorker()
  const c = new SqliteWorkerClient(w, 10) // 10ms timeout
  const p = c.request('x')

  // Never send a reply  -  let the 10ms timeout fire.
  await expect(p).rejects.toThrow(/timeout/)

  // Pending entry must be cleaned up: a late reply for that id must be silently
  // ignored and must NOT throw or resolve anything.
  const id = w.posted[0].id
  expect(() => w.onmessage({ data: { id, result: 'late' } })).not.toThrow()
})

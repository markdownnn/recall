// Unit tests for OffscreenWorkerStore using a FAKE Worker (postMessage +
// settable onmessage/onerror handlers). Proves: an { id, error } reply rejects
// only the matching call; a worker fault (onerror) rejects ALL pending calls so
// nothing hangs forever; a normal { id, result } reply resolves the right call.

import { OffscreenWorkerStore, type WorkerLike } from '../../src/offscreen/offscreen-worker-store'

class FakeWorker implements WorkerLike {
  posted: Array<{ id: number; op: string; args: unknown }> = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null

  postMessage(msg: unknown): void {
    this.posted.push(msg as { id: number; op: string; args: unknown })
  }

  // Test helpers to drive the store's handlers like a real Worker would.
  reply(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, result } } as MessageEvent)
  }
  replyError(id: number, error: string): void {
    this.onmessage?.({ data: { id, error } } as MessageEvent)
  }
  fault(message: string): void {
    this.onerror?.({ message })
  }
}

// Scenario: the worker reports an error for one op; only that call must reject,
// other in-flight calls must keep waiting for their own replies.
// Coverage: integration (real store dispatch, fake worker).
test('an { id, error } reply rejects only the matching call', async () => {
  const w = new FakeWorker()
  const store = new OffscreenWorkerStore(w)

  const p0 = store.pendingChunks(10)
  const p1 = store.pendingChunks(10)
  const id0 = w.posted[0].id
  const id1 = w.posted[1].id

  w.replyError(id0, 'boom')
  await expect(p0).rejects.toThrow('boom')

  // p1 was untouched: it still resolves on its own reply.
  w.reply(id1, [])
  await expect(p1).resolves.toEqual([])
})

// Scenario: the worker crashes or fails to init; EVERY pending promise must
// reject so IndexingService.running cannot get wedged true forever.
// Coverage: integration (fault rejects all; nothing left hanging).
test('a worker fault (onerror) rejects ALL pending calls', async () => {
  const w = new FakeWorker()
  const store = new OffscreenWorkerStore(w)

  const p0 = store.pendingChunks(10)
  const p1 = store.search(new Float32Array([1, 0]), 5)

  w.fault('worker crashed')

  await expect(p0).rejects.toThrow(/worker crashed/)
  await expect(p1).rejects.toThrow(/worker crashed/)
})

// Scenario: the normal happy path; a result reply resolves the right call.
// Coverage: integration (fake worker round-trip).
test('a normal { id, result } reply resolves the matching call', async () => {
  const w = new FakeWorker()
  const store = new OffscreenWorkerStore(w)

  const p = store.search(new Float32Array([1, 0]), 3)
  const id = w.posted[0].id
  const fakeResults = [{ chunk: { id: 'c1' }, page: { id: 'p1' }, score: 0.9 }]

  w.reply(id, fakeResults)

  await expect(p).resolves.toEqual(fakeResults)
})

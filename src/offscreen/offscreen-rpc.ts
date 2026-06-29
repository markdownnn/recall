// Reliable SW <-> offscreen RPC over chrome.runtime.sendMessage.
//
// WHY NOT sendResponse:
//   chrome.runtime.sendMessage delivers to ALL extension contexts that have an
//   onMessage listener. Only the FIRST call to sendResponse wins; any other
//   context that also calls sendResponse is silently ignored. This makes
//   sendResponse unreliable across the SW <-> offscreen boundary whenever other
//   extension contexts (popup, content scripts) are also open.
//
// THE FIX:
//   Never use sendResponse for RPC replies. Instead, tag every message with
//   { channel:'rpc', dir } and reply via a SEPARATE chrome.runtime.sendMessage.
//   Both sides return `false` from their listeners so they never claim the
//   response channel. Correlation is by an incrementing `id`.
//
// SW -> offscreen:  { channel:'rpc', dir:'to-offscreen', id, payload }
// offscreen -> SW:  { channel:'rpc', dir:'to-sw',        id, result }  (or error)
//
// Both directions are independent sendMessage calls.

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RpcRequest {
  channel: 'rpc'
  dir: 'to-offscreen'
  id: number
  payload: unknown
}

interface RpcReply {
  channel: 'rpc'
  dir: 'to-sw'
  id: number
  result?: unknown
  error?: string
}

// ---------------------------------------------------------------------------
// SW-side state
// ---------------------------------------------------------------------------

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const _pending = new Map<number, PendingEntry>()
let _nextId = 0
const TIMEOUT_MS = 30_000

// Callbacks registered by background/index.ts so callOffscreen can ensure the
// offscreen document exists (and re-create it on timeout-retry).
let _ensurer: (() => Promise<void>) | undefined
let _resetter: (() => void) | undefined

/**
 * Called once by the service worker at startup to provide the callbacks needed
 * for offscreen lifecycle management inside callOffscreen.
 *
 * @param ensurer  Creates the offscreen document if it does not already exist.
 * @param resetter Clears the cached document promise so the next ensurer() call
 *                 will do a real hasDocument() check and recreate if needed.
 */
export function registerOffscreenEnsurer(
  ensurer: () => Promise<void>,
  resetter: () => void,
): void {
  _ensurer = ensurer
  _resetter = resetter
}

// ---------------------------------------------------------------------------
// SW-side: installSwRpcListener
// ---------------------------------------------------------------------------

/**
 * Install the service-worker-side onMessage listener that resolves the Promises
 * created by callOffscreen() when the offscreen replies.
 *
 * Call ONCE at SW startup, after installling the app's existing listeners.
 * This listener is strictly additive: it returns false for every message that
 * is not an RPC reply, so it never interferes with other listeners.
 */
export function installSwRpcListener(): void {
  chrome.runtime.onMessage.addListener(
    (msg: unknown, _sender, _sendResponse): boolean => {
      const m = msg as Record<string, unknown>
      if (m?.channel !== 'rpc' || m?.dir !== 'to-sw') return false

      const id = m.id as number
      const entry = _pending.get(id)
      if (!entry) return false // stale or duplicate reply

      _pending.delete(id)
      clearTimeout(entry.timer)

      if (m.error !== undefined) {
        entry.reject(new Error(m.error as string))
      } else {
        entry.resolve(m.result)
      }
      return false // reply is already handled via the Map; do NOT claim the channel
    },
  )
}

// ---------------------------------------------------------------------------
// SW-side: callOffscreen
// ---------------------------------------------------------------------------

/**
 * Send a request to the offscreen document and await its reply.
 *
 * - Ensures the offscreen document exists before sending.
 * - On timeout, resets the document promise, recreates the document, and
 *   retries ONCE before rejecting.
 * - Multiple concurrent calls are safe: each gets a unique id and its own
 *   resolver in the pending Map.
 */
export async function callOffscreen<T>(payload: unknown): Promise<T> {
  if (_ensurer) await _ensurer()
  try {
    return await _singleCall<T>(payload)
  } catch (e) {
    if (
      e instanceof Error &&
      e.message.startsWith('[rpc] timeout') &&
      _ensurer &&
      _resetter
    ) {
      console.warn('[rpc] callOffscreen timed out on first attempt — recreating offscreen and retrying once')
      _resetter()
      await _ensurer()
      return _singleCall<T>(payload)
    }
    throw e
  }
}

/** Single attempt: send the message and wait for a reply from installSwRpcListener. */
function _singleCall<T>(payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = _nextId++

    const timer = setTimeout(() => {
      if (_pending.has(id)) {
        _pending.delete(id)
        reject(new Error(`[rpc] timeout: no reply for id=${id} after ${TIMEOUT_MS}ms`))
      }
    }, TIMEOUT_MS)

    _pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      timer,
    })

    const request: RpcRequest = { channel: 'rpc', dir: 'to-offscreen', id, payload }
    chrome.runtime.sendMessage(request).catch(() => {
      // Ignore all errors here. Possible causes:
      //   - "The message port closed" (offscreen returned false — expected)
      //   - "Receiving end does not exist" (offscreen died — timeout will handle it)
      // The REAL reply arrives via a new sendMessage from the offscreen; the
      // pending Map entry above is how we get notified.
    })
  })
}

// ---------------------------------------------------------------------------
// Offscreen-side: installOffscreenRpcHandler
// ---------------------------------------------------------------------------

/**
 * Install the offscreen-document-side onMessage listener.
 *
 * `handler` receives the payload and must return a result or throw an error.
 * The reply is ALWAYS sent as a new chrome.runtime.sendMessage — never via
 * sendResponse. This listener returns false immediately so it never claims
 * the response channel.
 *
 * Call ONCE when the offscreen document script loads.
 */
export function installOffscreenRpcHandler(
  handler: (payload: unknown) => Promise<unknown>,
): void {
  chrome.runtime.onMessage.addListener(
    (msg: unknown, _sender, _sendResponse): boolean => {
      const m = msg as Record<string, unknown>
      if (m?.channel !== 'rpc' || m?.dir !== 'to-offscreen') return false

      const id = m.id as number
      const payload = m.payload

      // Fire the handler asynchronously; reply via a new sendMessage.
      ;(async () => {
        let reply: RpcReply
        try {
          const result = await handler(payload)
          reply = { channel: 'rpc', dir: 'to-sw', id, result }
        } catch (err) {
          reply = { channel: 'rpc', dir: 'to-sw', id, error: String(err) }
        }
        chrome.runtime.sendMessage(reply).catch(() => {
          // SW may already be shutting down; ignore send failures.
        })
      })()

      // CRITICAL: return false immediately so we do NOT claim the response
      // channel of the original SW->offscreen message.
      return false
    },
  )
}

// Turn any thrown value into a human-readable string. WebLLM (and other libraries) sometimes
// throw plain objects with no `message`, so String(err) yields the useless "[object Object]"
// that hides the real cause from the user and the logs. Prefer a real message, then a JSON
// shape, and never throw ourselves.
export function describeError(err: unknown): string {
  if (typeof err === 'string') return err
  if (err === null || err === undefined) return 'Unknown error'
  if (err instanceof Error) return err.message || err.name || 'Error'
  if (typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    try {
      return JSON.stringify(err)
    } catch {
      // Circular or otherwise non-serializable: fall through to String().
    }
  }
  return String(err)
}

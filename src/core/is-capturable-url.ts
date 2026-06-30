// Can a content script run on this URL? Capture works by messaging the active tab's content
// script, which only injects on http/https/file pages. Browser-internal pages (the new-tab
// page, extension pages, settings, about:, data:, view-source:) and blank/empty tabs never
// have one, so the panel must NOT message them (the send would reject with "Receiving end
// does not exist"). Pure URL logic, shared by the side panel guard and the SAVED-badge skip.
export function isCapturableUrl(url: string): boolean {
  if (!url) return false
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:' || p === 'file:'
  } catch {
    return false
  }
}

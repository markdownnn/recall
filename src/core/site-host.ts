// The host used for "don't remember this site" / "forget this site". Strips a
// leading www. ONLY when at least two labels remain, so a single-label result
// like 'com' (from www.com) can never blanket-match every *.com. Lowercased.
export function siteHost(hostname: string): string {
  const h = hostname.toLowerCase()
  const stripped = h.replace(/^www\./, '')
  return stripped.includes('.') ? stripped : h
}

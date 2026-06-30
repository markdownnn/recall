// Known tracking/analytics query params that never change WHICH page you see, so they
// must not be part of a page's identity. Case-insensitive keys. Pure + testable.
// NOTE: deliberately NO 'ref'/'ref_src'. Those are real CONTENT params on some sites
// (e.g. ?ref=<author> on docs/blogs, ?ref_src on Twitter embeds) - stripping them would
// merge two genuinely-different pages, breaking the "never merge distinct pages" guarantee.
// Only params that never change WHICH page you see belong here.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'msclkid', 'mc_eid', 'igshid',
  '_hsenc', '_hsmi', 'vero_id', 'oly_enc_id',
])

export function stripTrackingParams(url: string): string {
  try {
    const u = new URL(url)
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k)
    }
    return u.toString()
  } catch {
    return url
  }
}

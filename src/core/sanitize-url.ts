// Remove token-like query params so secret-bearing URLs (magic links, OAuth
// callbacks, password resets) are not stored verbatim. Pure + testable.
import { stripTrackingParams } from './strip-tracking-params'

const TOKEN_PARAMS =
  /^(access_token|refresh_token|id_token|token|auth|code|otp|oauth_token|reset_token|session|sessionid|sid|key|secret|password|pwd|api_key|apikey|signature|sig)$/i

export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const k of [...u.searchParams.keys()]) {
      if (TOKEN_PARAMS.test(k)) u.searchParams.delete(k)
    }
    // Also drop tracking/campaign params so the STORED url is clean.
    return stripTrackingParams(u.toString())
  } catch {
    return url
  }
}

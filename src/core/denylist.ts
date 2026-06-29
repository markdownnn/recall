// A denylist entry is a RegExp tested against the full URL (lowercased).
export const DEFAULT_DENYLIST: RegExp[] = [
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.local)([:/]|$)/,
  /\/(login|signin|sign-in|logout|checkout|payment|pay|billing|account|settings|password|auth)(\/|$|\?)/,
  /^https?:\/\/mail\./,
  /^https?:\/\/[^/]*(bank|paypal|stripe|venmo|wallet)/,
  /^https?:\/\/(outlook|accounts|login|signin|auth)\./,
]

export function isDenylisted(url: string, list: RegExp[] = DEFAULT_DENYLIST): boolean {
  const u = url.toLowerCase()
  return list.some((re) => re.test(u))
}

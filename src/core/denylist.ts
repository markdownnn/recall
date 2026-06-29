// A denylist entry is a RegExp tested against the full URL (lowercased).
//
// IMPORTANT: this list is BEST-EFFORT, not a guarantee. It cannot be exhaustive —
// new banks, health portals, and auth flows appear constantly. The real defences are
// layered: (1) this list catches many common sensitive hosts/paths at capture time;
// (2) Fix-2 content sensitivity signals (robots noindex/noarchive, visible password
// fields) catch pages the list misses; (3) the user's own "don't remember this site"
// per-host block is the authoritative user-controlled override.
export const DEFAULT_DENYLIST: RegExp[] = [
  // Local/dev addresses — never worth storing.
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.local)([:/]|$)/,

  // Sensitive path segments — auth, admin, finance, account management, MFA flows.
  /\/(login|signin|sign-in|logout|checkout|payment|pay|billing|account|settings|password|auth|admin|dashboard|oauth|authorize|verify|2fa|mfa|wallet|vault|reset|recover)(\/|$|\?)/,

  // Webmail — contains private messages.
  /^https?:\/\/mail\./,

  // Financial/banking/crypto hosts.
  /^https?:\/\/[^/]*(bank|paypal|stripe|venmo|wallet|chase|wellsfargo|citibank|capitalone|americanexpress|amex|fidelity|schwab|coinbase|robinhood)/,

  // Health portals.
  /^https?:\/\/[^/]*(mychart|myuhc)/,

  // Password managers.
  /^https?:\/\/[^/]*(1password|bitwarden|lastpass|dashlane|fastmail)/,

  // Common auth/SSO subdomains.
  /^https?:\/\/(outlook|accounts|login|signin|auth)\./,
]

export function isDenylisted(url: string, list: RegExp[] = DEFAULT_DENYLIST): boolean {
  const u = url.toLowerCase()
  return list.some((re) => re.test(u))
}

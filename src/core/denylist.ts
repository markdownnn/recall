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
  // NOTE: [^/]* here has the same host-label over-match as the old task-board pattern.
  // Fixing it is out of scope for this change.
  /^https?:\/\/[^/]*(bank|paypal|stripe|venmo|wallet|chase|wellsfargo|citibank|capitalone|americanexpress|amex|fidelity|schwab|coinbase|robinhood)/,

  // Health portals.
  /^https?:\/\/[^/]*(mychart|myuhc)/,

  // Password managers.
  /^https?:\/\/[^/]*(1password|bitwarden|lastpass|dashlane|fastmail)/,

  // Common auth/SSO subdomains.
  /^https?:\/\/(outlook|accounts|login|signin|auth)\./,

  // Productivity / app UIs you OPERATE rather than READ - calendars, chat, task boards,
  // cloud consoles, maps. These common "short-head" tool screens are not worth recalling
  // as articles. Documents (docs.google.com) and code (github.com) are left OUT on
  // purpose - those are content you may want to recall.
  /^https?:\/\/(calendar|meet|drive|contacts|photos|chat|keep)\.google\./,
  /^https?:\/\/maps\.(google|apple)\.com/,
  /^https?:\/\/(www\.)?google\.[a-z.]+\/maps(\/|$|\?)/,
  // Chat / messaging app screens.
  /^https?:\/\/(app\.slack\.com|discord\.com\/(app|channels)|web\.whatsapp\.com|web\.telegram\.org|teams\.(microsoft|live)\.com|(www\.)?messenger\.com|web\.skype\.com)/,
  // Task / project-management boards.
  // ([a-z0-9-]+\.)* anchors each brand to a host-label boundary so that
  // e.g. nottrello.com and cyber-monday.com are not wrongly blocked.
  // atlassian.net has no leading dot here: bare apex and *.atlassian.net are both covered.
  /^https?:\/\/([a-z0-9-]+\.)*(trello\.com|asana\.com|monday\.com|clickup\.com|basecamp\.com|atlassian\.net)([/:?]|$)/,
  // Cloud / infra consoles.
  /^https?:\/\/(console\.aws\.amazon\.com|[^/]*\.console\.aws\.amazon\.com|portal\.azure\.com|console\.cloud\.google\.com)/,
]

export function isDenylisted(url: string, list: RegExp[] = DEFAULT_DENYLIST): boolean {
  const u = url.toLowerCase()
  return list.some((re) => re.test(u))
}

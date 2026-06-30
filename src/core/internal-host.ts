// Detects whether a hostname belongs to an INTERNAL / private network, from the hostname
// STRING ALONE - no DNS, no IP resolution, no new permissions. This is the CHEAP locality
// check. Internal hosts are intranet / home / dev-network pages, not public web content,
// so auto-capture should skip them.
//
// Detection is deliberately PRECISE to avoid false positives on real public domains:
//   - 172.200.x is PUBLIC; only 172.16-31 is private (172.16.0.0/12).
//   - mylocal.com is PUBLIC; only the `.local` SUFFIX is internal.
//   - example.com has a dot, so it is NOT a single-label intranet host.
//
// Kept SEPARATE from the privacy denylist ("never store") and isSerp ("low value");
// mirrors isSerp's shape: one pure predicate.

// Conventional intranet suffixes (mDNS / split-horizon naming) + reserved non-routable
// TLDs (RFC 2606 / 6761). SUFFIX match only.
// NOTE: `.example` is deliberately NOT here. It is a documentation-only TLD nobody actually
// browses, so flagging it as internal has no real-world value - it only ever bit our own
// e2e fixtures (which used `*.example` hosts) by silently skipping their auto-capture.
const INTERNAL_SUFFIXES = [
  '.local', '.internal', '.corp', '.lan', '.intranet', '.home', '.localdomain',
  '.test', '.localhost', '.invalid',
]

export function isInternalHost(hostname: string): boolean {
  if (!hostname) return false
  let host = hostname.toLowerCase()
  // URL hostnames keep IPv6 in brackets ([::1]); strip them to inspect the address.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)

  if (host === 'localhost') return true
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return true
  if (isPrivateIpv4(host)) return true
  if (isPrivateIpv6(host)) return true
  // Single-label hostnames (no dot, no colon) are intranet shortcuts - public DNS needs a
  // dot. IPv4 literals have dots and IPv6 literals have colons, handled above.
  if (!host.includes('.') && !host.includes(':')) return true
  return false
}

// 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 (loopback), 169.254.0.0/16
// (link-local). A public IP (8.8.8.8, 172.200.x) simply matches no branch.
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1]); const b = Number(m[2])
  if (a === 10) return true
  if (a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

// ::1 (loopback), fc00::/7 ULA (first hextet 0xfc00..0xfdff), fe80::/10 link-local
// (0xfe80..0xfebf). Public IPv6 (2001:db8::1) matches no branch.
function isPrivateIpv6(host: string): boolean {
  if (!host.includes(':')) return false
  if (host === '::1') return true
  const first = host.split(':')[0]
  if (first === '') return false // "::<other>" - not a private prefix
  const n = parseInt(first, 16)
  if (Number.isNaN(n)) return false
  if (n >= 0xfc00 && n <= 0xfdff) return true // ULA
  if (n >= 0xfe80 && n <= 0xfebf) return true // link-local
  return false
}

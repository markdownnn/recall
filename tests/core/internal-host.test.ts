import { isInternalHost } from '../../src/core/internal-host'

// Scenario: a page served from a private/intranet host is not public web content; every
// private-network form must be recognized so auto-capture skips it.
// Coverage: integration (pure hostname check over real private-host forms).
test('recognizes internal / private-network hosts', () => {
  const internal = [
    // Private IPv4 ranges.
    '10.0.0.5', '10.255.255.255',
    '172.16.0.1', '172.31.255.1',
    '192.168.1.1',
    '127.0.0.1',           // loopback
    '169.254.1.1',         // link-local
    // IPv6 loopback / ULA / link-local (and the bracketed URL form).
    '::1', '[::1]',
    'fc00::1', 'fd12:3456:789a::1',
    'fe80::1',
    // localhost + conventional intranet suffixes.
    'localhost',
    'wiki.local', 'printer.internal', 'jira.corp',
    'nas.lan', 'docs.intranet', 'router.home', 'box.localdomain',
    // Reserved / non-routable TLDs.
    'app.test', 'site.localhost', 'thing.invalid', 'demo.example',
    // Single-label hosts (no dot at all) - intranet shortcuts.
    'wiki', 'jira', 'confluence',
  ]
  for (const h of internal) expect(isInternalHost(h)).toBe(true)
})

// Scenario: a real PUBLIC domain that merely LOOKS close to a private form must NOT be
// flagged, or we would wrongly skip real articles.
// Coverage: integration (pure hostname check, false-positive guard).
test('does not flag public hosts that look close', () => {
  const publicHosts = [
    'en.wikipedia.org', 'github.com', 'example.org',
    '8.8.8.8', '1.1.1.1',          // public DNS resolvers
    '11.0.0.1',                    // 11.x is public (only 10.x is private)
    '172.15.0.1', '172.32.0.1', '172.200.0.1', // only 172.16-31 is private
    '192.169.1.1',                 // 192.168 only
    'mylocal.com',                 // only the .local SUFFIX is internal
    'corp.example.com',            // .corp must be a SUFFIX, not a label
    '2001:db8::1',                 // public IPv6 doc range, not ULA/link-local
  ]
  for (const h of publicHosts) expect(isInternalHost(h)).toBe(false)
})

// Scenario: an empty hostname (e.g. file:// pages have host='') must not throw and must
// not be treated as internal - the gate runs on every page.
// Coverage: integration (pure hostname check, empty path).
test('empty hostname is not internal', () => {
  expect(isInternalHost('')).toBe(false)
})

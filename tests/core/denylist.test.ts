import { DEFAULT_DENYLIST, isDenylisted } from '../../src/core/denylist'

test('blocks localhost and loopback', () => {
  expect(isDenylisted('http://localhost:3000/x', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('http://127.0.0.1/x', DEFAULT_DENYLIST)).toBe(true)
})

test('blocks auth and payment paths', () => {
  expect(isDenylisted('https://site.com/login', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://site.com/checkout/pay', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://site.com/account/settings', DEFAULT_DENYLIST)).toBe(true)
})

test('blocks webmail and banking hosts', () => {
  expect(isDenylisted('https://mail.google.com/u/0', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://www.paypal.com/home', DEFAULT_DENYLIST)).toBe(true)
})

test('allows ordinary article pages', () => {
  expect(isDenylisted('https://en.wikipedia.org/wiki/Cortisol', DEFAULT_DENYLIST)).toBe(false)
  expect(isDenylisted('https://someblog.com/posts/sleep-science', DEFAULT_DENYLIST)).toBe(false)
})

test('blocks known banking hosts', () => {
  expect(isDenylisted('https://www.chase.com/personal/checking', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://online.wellsfargo.com/das/cgi-bin/session.cgi', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://www.coinbase.com/portfolio', DEFAULT_DENYLIST)).toBe(true)
})

test('blocks health portal hosts', () => {
  expect(isDenylisted('https://mychart.example.org/patient', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://portal.myuhc.com/member', DEFAULT_DENYLIST)).toBe(true)
})

test('blocks password manager hosts', () => {
  expect(isDenylisted('https://my.1password.com/vaults', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://vault.bitwarden.com/#/login', DEFAULT_DENYLIST)).toBe(true)
})

test('blocks admin and dashboard paths', () => {
  expect(isDenylisted('https://app.example.com/admin/users', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://app.example.com/dashboard', DEFAULT_DENYLIST)).toBe(true)
})

test('blocks MFA and OAuth paths', () => {
  expect(isDenylisted('https://example.com/oauth/authorize', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://example.com/2fa/verify', DEFAULT_DENYLIST)).toBe(true)
})

test('a normal blog is still allowed after broadening', () => {
  expect(isDenylisted('https://myblog.com/posts/reading-list', DEFAULT_DENYLIST)).toBe(false)
  expect(isDenylisted('https://news.ycombinator.com/item?id=12345', DEFAULT_DENYLIST)).toBe(false)
})

test('blocks operate-not-read app UIs (calendars, chat, boards, consoles, maps)', () => {
  // Google app screens
  expect(isDenylisted('https://calendar.google.com/calendar/u/0/r', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://meet.google.com/abc-defg-hij', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://drive.google.com/drive/my-drive', DEFAULT_DENYLIST)).toBe(true)
  // Maps
  expect(isDenylisted('https://maps.google.com/maps', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://www.google.com/maps/place/x', DEFAULT_DENYLIST)).toBe(true)
  // Chat / messaging
  expect(isDenylisted('https://app.slack.com/client/T1/C1', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://discord.com/channels/123/456', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://web.whatsapp.com/', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://teams.microsoft.com/_#/conversations', DEFAULT_DENYLIST)).toBe(true)
  // PM boards
  expect(isDenylisted('https://trello.com/b/abc/board', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://app.asana.com/0/123', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://acme.atlassian.net/jira/software', DEFAULT_DENYLIST)).toBe(true)
  // Cloud consoles
  expect(isDenylisted('https://console.aws.amazon.com/ec2/home', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://portal.azure.com/#home', DEFAULT_DENYLIST)).toBe(true)
})

test('keeps allowing content sites that look app-like (docs, code, video, notion)', () => {
  // Documents and code are content you may want to recall - NOT blocked.
  expect(isDenylisted('https://docs.google.com/document/d/abc/edit', DEFAULT_DENYLIST)).toBe(false)
  expect(isDenylisted('https://github.com/openai/whisper', DEFAULT_DENYLIST)).toBe(false)
  expect(isDenylisted('https://www.youtube.com/watch?v=abc', DEFAULT_DENYLIST)).toBe(false)
  expect(isDenylisted('https://www.notion.so/Some-Public-Page-123', DEFAULT_DENYLIST)).toBe(false)
})

// --- Task / project-management host boundary fix ---
// RED (over-match): a domain that merely ENDS in the brand string must NOT be blocked.
test('does not block domains that end with a brand string but are not the brand', () => {
  expect(isDenylisted('https://nottrello.com/x', DEFAULT_DENYLIST)).toBe(false)
  expect(isDenylisted('https://cyber-monday.com/deals', DEFAULT_DENYLIST)).toBe(false)
})

// A path or query string that contains the brand name is NOT a board host.
test('does not block when brand appears only in the path or query, not the host', () => {
  expect(isDenylisted('https://example.com/go?to=trello.com', DEFAULT_DENYLIST)).toBe(false)
})

// Positive cases: exact brand hosts and their subdomains must still be blocked.
test('blocks task-management brands at the host-label boundary', () => {
  // bare apex
  expect(isDenylisted('https://trello.com/b/abc/board', DEFAULT_DENYLIST)).toBe(true)
  // www subdomain
  expect(isDenylisted('https://www.trello.com/', DEFAULT_DENYLIST)).toBe(true)
  // arbitrary subdomain
  expect(isDenylisted('https://x.monday.com/boards', DEFAULT_DENYLIST)).toBe(true)
  // asana with app subdomain
  expect(isDenylisted('https://app.asana.com/0/1', DEFAULT_DENYLIST)).toBe(true)
  // atlassian.net with tenant subdomain
  expect(isDenylisted('https://acme.atlassian.net/jira', DEFAULT_DENYLIST)).toBe(true)
  // atlassian.net bare apex (old pattern wrongly missed this - now fixed)
  expect(isDenylisted('https://atlassian.net/home', DEFAULT_DENYLIST)).toBe(true)
})

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

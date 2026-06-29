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

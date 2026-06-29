import { sanitizeUrl } from '../../src/core/sanitize-url'

test('strips access_token param', () => {
  const url = 'https://app.example.com/callback?access_token=abc123&state=xyz'
  const result = sanitizeUrl(url)
  expect(result).not.toContain('access_token')
  expect(result).toContain('state=xyz')
})

test('strips multiple token params in one shot', () => {
  const url = 'https://example.com/reset?code=111&reset_token=secret&email=user@example.com'
  const result = sanitizeUrl(url)
  expect(result).not.toContain('code=')
  expect(result).not.toContain('reset_token=')
  expect(result).toContain('email=user%40example.com')
})

test('keeps non-token params untouched', () => {
  const url = 'https://shop.example.com/items?id=5&page=2&sort=asc'
  expect(sanitizeUrl(url)).toBe(url)
})

test('leaves a clean url unchanged', () => {
  const url = 'https://en.wikipedia.org/wiki/Cortisol'
  expect(sanitizeUrl(url)).toBe(url)
})

test('returns a bad url as-is without throwing', () => {
  const bad = 'not a url at all'
  expect(sanitizeUrl(bad)).toBe(bad)
})

test('strips oauth_token and signature params', () => {
  const url = 'https://api.example.com/auth?oauth_token=tok&signature=sig123&v=1.0'
  const result = sanitizeUrl(url)
  expect(result).not.toContain('oauth_token')
  expect(result).not.toContain('signature')
  expect(result).toContain('v=1.0')
})

test('case-insensitive match on token param names', () => {
  const url = 'https://example.com/login?Access_Token=abc&Name=alice'
  const result = sanitizeUrl(url)
  expect(result).not.toContain('Access_Token')
  expect(result).toContain('Name=alice')
})

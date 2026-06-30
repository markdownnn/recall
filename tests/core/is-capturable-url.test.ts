import { isCapturableUrl } from '../../src/core/is-capturable-url'

// Scenario: the side panel must decide BEFORE messaging a tab whether the page can hold a
// content script. http/https/file pages can; everything else (chrome://, extension pages,
// about:blank, empty) cannot, so we must not send them an extract-and-capture message.
// Coverage: integration (real pure helper).
test('capturable schemes: http, https, file are true', () => {
  expect(isCapturableUrl('http://example.com/a')).toBe(true)
  expect(isCapturableUrl('https://example.com/a')).toBe(true)
  expect(isCapturableUrl('file:///Users/x/page.html')).toBe(true)
})

// Scenario: restricted pages where a content script can never run must be rejected so the
// panel shows a friendly "can't be saved" line instead of a raw connection error.
// Coverage: integration (real pure helper).
test('restricted schemes and empty are false', () => {
  expect(isCapturableUrl('chrome://newtab')).toBe(false)
  expect(isCapturableUrl('chrome-extension://abc/page.html')).toBe(false)
  expect(isCapturableUrl('edge://settings')).toBe(false)
  expect(isCapturableUrl('about:blank')).toBe(false)
  expect(isCapturableUrl('view-source:http://example.com')).toBe(false)
  expect(isCapturableUrl('data:text/html,hi')).toBe(false)
  expect(isCapturableUrl('')).toBe(false)
})

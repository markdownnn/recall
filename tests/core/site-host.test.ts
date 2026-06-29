import { describe, it, expect } from 'vitest'
import { siteHost } from '../../src/core/site-host'

describe('siteHost', () => {
  it('strips www. when two labels remain', () => {
    expect(siteHost('www.bank.com')).toBe('bank.com')
  })

  it('does NOT strip www. when stripping would leave a single label', () => {
    expect(siteHost('www.com')).toBe('www.com')
  })

  it('returns unchanged when no www. prefix', () => {
    expect(siteHost('bank.com')).toBe('bank.com')
  })

  it('returns unchanged for multi-label non-www host', () => {
    expect(siteHost('mail.proton.me')).toBe('mail.proton.me')
  })

  it('lowercases the result and strips www.', () => {
    expect(siteHost('WWW.Bank.COM')).toBe('bank.com')
  })
})

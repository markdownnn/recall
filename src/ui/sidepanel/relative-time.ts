// Compact ASCII "time since" for the History list. Pure + now-injected so it is testable
// without a clock. Buckets: <60s just now, <60m Nm, <24h Nh, <~30d Nd, else "Mon D".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function relativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  const dt = new Date(then)
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}`
}

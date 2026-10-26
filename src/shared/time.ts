const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function timeAgo(ms: number, now = Date.now()): string {
  if (!ms) return 'never'
  const d = now - ms
  if (d < MINUTE) return 'just now'
  if (d < HOUR) return `${Math.floor(d / MINUTE)}m ago`
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`
  if (d < 2 * DAY) return 'yesterday'
  if (d < 30 * DAY) return `${Math.floor(d / DAY)}d ago`
  if (d < 365 * DAY) return `${Math.floor(d / (30 * DAY))}mo ago`
  return `${Math.floor(d / (365 * DAY))}y ago`
}

export function daysSince(ms: number, now = Date.now()): number {
  return ms ? (now - ms) / DAY : Infinity
}

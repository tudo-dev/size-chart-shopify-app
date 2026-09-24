/**
 * Times for people in Nepal.
 *
 * Every timestamp the app writes is UTC text — `2026-09-17 10:18:05`, see
 * `asColumnText` in shared/analytics-window — and the Payments page printed
 * it as it was, so a write that finished at four in the afternoon read
 * "10:18" (2026-09-18). The office is in Nepal and the couriers' own reports
 * are in Nepal time, so a time shown to a person is Nepal time, fixed by the
 * zone and not by whatever clock the reader's browser happens to keep.
 *
 * The month names are our own rather than the locale's: `en-GB` prints
 * "Sept", `en-US` puts the day after the month, and the other pages already
 * write "18 Sep 2026, 12:15" (see decisions.vue), so this matches them.
 */

const NEPAL_TZ = 'Asia/Kathmandu'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The column's own shape (`YYYY-MM-DD HH:MM:SS`, always UTC), an ISO instant, or a number of ms — as a Date, or null when it is none of those. */
export function instantOf(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null
  const text = value.trim()
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

// hourCycle h23: some engines print midnight as "24" under hour12: false.
const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: NEPAL_TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function nepalParts(date: Date): Record<string, string> {
  return Object.fromEntries(parts.formatToParts(date).map(part => [part.type, part.value]))
}

/** `2026-09-17 10:18:05` → `17 Sep 2026, 16:03` (Nepal time); nothing usable → `—`. */
export function nepalDateTime(value: string | number | Date | null | undefined): string {
  const date = instantOf(value)
  if (!date) return '—'
  const p = nepalParts(date)
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute}`
}

const isoParts = new Intl.DateTimeFormat('en-CA', { timeZone: NEPAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

/** `2026-09-17 18:20:00` → `2026-09-18` — the Nepal day as an API wants it (Hulagi's startDate/endDate); nothing usable → ''. */
export function nepalIsoDate(value: string | number | Date | null | undefined): string {
  const date = instantOf(value)
  if (!date) return ''
  return isoParts.format(date)
}

/** `2026-09-17 18:20:00` → `18 Sep 2026` — the Nepal day, which can be the day after the UTC one. */
export function nepalDate(value: string | number | Date | null | undefined): string {
  const date = instantOf(value)
  if (!date) return '—'
  const p = nepalParts(date)
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}`
}

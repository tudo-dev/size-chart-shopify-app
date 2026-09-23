/** A moment as the database stores it: `YYYY-MM-DD HH:MM:SS`, always UTC. */
export function columnText(moment: Date | number = new Date()): string {
  const date = typeof moment === 'number' ? new Date(moment) : moment
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** The reverse of columnText; null for anything that is not a real moment. */
export function fromColumnText(text: string | null | undefined): Date | null {
  if (!text) return null
  const date = new Date(`${text.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Paging and search for the chart list — the two pieces of Tudoholic
 * Logistics' payment-lists.ts the size chart code used, moved unchanged.
 */

export const PAGE_SIZE_DEFAULT = 30
export const PAGE_SIZE_MAX = 200
/** Longer than any product id or name; keeps a pasted paragraph from becoming a LIKE pattern. */
const SEARCH_MAX_CHARS = 60

export interface ListQuery {
  page: number
  size: number
  q: string
}

/** Page, page size and search word from a query string, each brought back into range rather than trusted. */
export function parseListQuery(query: Record<string, unknown>): ListQuery {
  const pageRaw = Number(query.page)
  const sizeRaw = Number(query.size)
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1
  const size = Number.isInteger(sizeRaw) && sizeRaw >= 1 ? Math.min(sizeRaw, PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, SEARCH_MAX_CHARS) : ''
  return { page, size, q }
}

/** A search word as a LIKE pattern, with its own % and _ taken literally. Use with `escape '\'`. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, char => `\\${char}`)}%`
}

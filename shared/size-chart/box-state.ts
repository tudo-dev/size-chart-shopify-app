/**
 * Is the Size chart box on the live theme? Read from App Bridge's
 * `shopify.app.extensions()` (shopify.dev, App API, checked 2026-09-25).
 *
 * Its answer lists every extension the app ships. A theme app extension's
 * `activations` has one entry PER BLOCK FILE, each with its own status:
 * `active` when the block is placed on the live theme, `available` when it
 * is not, `unavailable` when it is switched off. The entry is there either
 * way, so the length of the list says nothing: only the block's own status
 * does. Anything not in that shape means "cannot tell", never "it is there".
 *
 * The block is found by its own handle (the block file's name) inside ANY
 * theme app extension of the app, not only inside one handled `size-chart`:
 * Shopify has been seen reporting a theme app extension under a stale or
 * generic handle such as `theme-app-extension` (community.shopify.dev,
 * April 2026), and on tudoholic-com the check said "cannot tell" on the
 * day the box was released. When it still cannot tell, `why` says what
 * Shopify answered, so the page can show it instead of guessing.
 */

export type BoxState = 'on' | 'missing' | 'unknown'

export interface BoxCheck {
  state: BoxState
  /** Only when the state is unknown: what Shopify answered, in a few words. */
  why: string | null
}

const WHY_LIMIT = 300

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function words(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '?'
}

/** A short picture of Shopify's answer, for the page to show when it cannot tell. */
function describe(entries: unknown[]): string {
  const text = entries.map((entry) => {
    if (!isRecord(entry)) return 'something that is not an extension'
    const blocks = Array.isArray(entry.activations)
      ? entry.activations.map(block => isRecord(block) ? `${words(block.handle)} ${words(block.status)}` : '?').join(', ')
      : 'no block list'
    return `${words(entry.handle)} (${words(entry.type)}: ${blocks || 'no blocks'})`
  }).join('; ')
  return text.length > WHY_LIMIT ? `${text.slice(0, WHY_LIMIT - 1)}…` : text
}

export function boxCheckFrom(extensions: unknown, handle = 'size-chart'): BoxCheck {
  if (!Array.isArray(extensions)) return { state: 'unknown', why: 'Shopify\'s answer was not a list of the app\'s parts.' }
  const themeExtensions = extensions.filter(entry => isRecord(entry) && (entry.handle === handle || entry.type === 'theme_app_extension'))
  const blocks = themeExtensions.flatMap(entry => Array.isArray(entry.activations) ? entry.activations : [])
    .filter(block => isRecord(block) && block.handle === handle) as Array<{ status?: unknown }>
  if (extensions.length === 0) return { state: 'unknown', why: 'Shopify listed none of the app\'s parts.' }
  if (blocks.length === 0) return { state: 'unknown', why: `Shopify listed ${describe(extensions)}, with no Size chart box in it.` }
  // Listed more than once (an old copy beside the new one): placed anywhere counts as placed.
  if (blocks.some(block => block.status === 'active')) return { state: 'on', why: null }
  if (blocks.every(block => block.status === 'available' || block.status === 'unavailable')) return { state: 'missing', why: null }
  return { state: 'unknown', why: `Shopify gave the Size chart box the status ${blocks.map(block => words(block.status)).join(', ')}.` }
}

export function boxStateFrom(extensions: unknown, handle = 'size-chart'): BoxState {
  return boxCheckFrom(extensions, handle).state
}

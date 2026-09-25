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
 */

export type BoxState = 'on' | 'missing' | 'unknown'

export function boxStateFrom(extensions: unknown, handle = 'size-chart'): BoxState {
  if (!Array.isArray(extensions)) return 'unknown'
  const ours = extensions.find(entry => entry && typeof entry === 'object' && (entry as { handle?: unknown }).handle === handle) as { activations?: unknown } | undefined
  if (!ours || !Array.isArray(ours.activations)) return 'unknown'
  const block = ours.activations.find(entry => entry && typeof entry === 'object' && (entry as { handle?: unknown }).handle === handle) as { status?: unknown } | undefined
  if (!block) return 'unknown'
  if (block.status === 'active') return 'on'
  if (block.status === 'available' || block.status === 'unavailable') return 'missing'
  return 'unknown'
}

/**
 * The only /api paths that answer without a Shopify login — see
 * server/middleware/require-shop.ts. Kept apart so the rule is tested alone.
 *
 *   /api/health     — says the server is up, nothing about any store
 *   /api/webhooks/* — Shopify's own messages, each proven by its signature
 */
export function isOpenPath(path: string): boolean {
  return path === '/api/health' || path.startsWith('/api/webhooks/')
}

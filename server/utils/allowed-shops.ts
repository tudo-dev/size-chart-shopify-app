/**
 * Which stores may use this app.
 *
 * Every store the app is installed on signs its logins with the same app
 * secret, and the size-chart tables do not say which store a row belongs to.
 * So once the app is live, the logx test store (where `shopify app dev` put it)
 * would open the live app too — and a Sync there would replace the live
 * store's product map with the test store's (found 2026-09-24, before the
 * first deploy). ALLOWED_SHOPS in the server's .env names the stores allowed
 * in, comma-separated myshopify domains.
 *
 * Unset on the server, NOBODY gets in, so a forgotten line shows up at once
 * instead of leaving the door open. Unset on a laptop (`nuxt dev`), any store
 * may: that is where the test store is used.
 *
 * Kept free of Nuxt imports so the verify suite can load it directly.
 */
export function shopAllowed(shop: string, allowedShops: string | undefined, isDev: boolean): boolean {
  const shops = (allowedShops ?? '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)
  if (shops.length === 0) return isDev
  return shops.includes(shop.trim().toLowerCase())
}

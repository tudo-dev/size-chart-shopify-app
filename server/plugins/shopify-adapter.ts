/**
 * Loads the Shopify library's Node adapter as the server starts.
 *
 * The static import at the top of server/utils/shopify.ts is what normally
 * does this, and nuxt.config's `nitro.moduleSideEffects` keeps the build from
 * dropping it. This is the second line of defence, copied from Tudoholic
 * Logistics (server/plugins/shopifyAdapter.ts): without the adapter every
 * login fails with "Missing adapter implementation" (2026-09-24).
 */
export default defineNitroPlugin(async () => {
  await import('@shopify/shopify-api/adapters/node')
})

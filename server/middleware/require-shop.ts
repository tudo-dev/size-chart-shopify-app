/**
 * No /api route answers without a verified Shopify login — one guard in front
 * of all of them, so a route added later cannot forget the check.
 *
 * Why here and not in each route: the size chart routes came from Tudoholic
 * Logistics, where three of them (summary, list, one chart) looked up the shop
 * but carried on when there was none. On 2026-09-23 logistics.tudoholic.com
 * answered them for anyone on the internet: 100 charts, the 77,230-product map,
 * the 1688 supplier links and pictures. This app is on the open internet too.
 *
 * Open without a login: only what isOpenPath (server/utils/open-paths.ts) names.
 */
import { getRequestURL } from 'h3'
import { isOpenPath } from '../utils/open-paths'
import { shopifyCredentials } from '../utils/scopes'
import { shopAllowed } from '../utils/allowed-shops'

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/') || isOpenPath(path)) return
  const sessionToken = getSessionTokenFromHeaders(event)
  if (!sessionToken) throw createError({ statusCode: 401, statusMessage: 'Open the app from Shopify admin.' })
  try {
    event.context.shop = await verifiedShop(sessionToken)
  }
  catch (error) {
    // Why, so a refusal can be told apart from a wrong key or a missing
    // secret — never the token itself, which the Shopify library puts inside
    // its own error message.
    const reason = error instanceof Error ? error.message.replace(/'[^']*'/g, '\'…\'') : String(error)
    const { apiKey, apiSecretKey } = shopifyCredentials()
    console.warn(`[login] refused ${path}: ${reason} (key set: ${apiKey ? 'yes' : 'no'}, secret set: ${apiSecretKey ? 'yes' : 'no'})`)
    throw createError({ statusCode: 401, statusMessage: 'Your Shopify session could not be verified. Reload the app.' })
  }
  // A real login from a store this app is not set up for (server/utils/allowed-shops.ts).
  if (!shopAllowed(event.context.shop, process.env.ALLOWED_SHOPS, import.meta.dev)) {
    console.warn(`[login] refused ${path}: ${event.context.shop} is not in ALLOWED_SHOPS${process.env.ALLOWED_SHOPS ? '' : ' (ALLOWED_SHOPS is not set on this server)'}`)
    throw createError({ statusCode: 403, statusMessage: 'This app is not set up for this store.' })
  }
})

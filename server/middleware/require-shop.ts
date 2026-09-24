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

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/') || isOpenPath(path)) return
  const sessionToken = getSessionTokenFromHeaders(event)
  if (!sessionToken) throw createError({ statusCode: 401, statusMessage: 'Open the app from Shopify admin.' })
  try {
    event.context.shop = await verifiedShop(sessionToken)
  }
  catch {
    throw createError({ statusCode: 401, statusMessage: 'Your Shopify session could not be verified. Reload the app.' })
  }
})

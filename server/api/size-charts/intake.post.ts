/**
 * Run the intake again without a new workbook: walk the whole product list
 * (the "Sync products" button) and fetch every picture still missing,
 * including the ones whose last attempt failed. Fetching only — the reading
 * is its own press, so this button never spends money.
 *
 *   POST /api/size-charts/intake    body: { full?: boolean }
 */

import { getAccessToken } from '../../utils/shopify'
import { createShopifyClientFromToken } from '../../utils/shopify-client-from-token'
import { startIntakeJob } from '../../utils/size-chart-jobs'

export default defineEventHandler(async (event) => {
  try {
    const { session } = await getAccessToken(event)
    if (!session.shop || !session.accessToken) throw new Error('No Shopify session for this request')
    const body = (await readBody(event).catch(() => null)) as { full?: unknown } | null
    const client = createShopifyClientFromToken(session.shop, session.accessToken, getRequestURL(event).host)
    // Deliberately NOT thenRead: reading costs money, so it stays a separate
    // press. On 2026-09-20 a Sync products read all 84 pictures by surprise.
    const job = startIntakeJob(client, { fullSync: body?.full === true, retryFailed: true })
    return { success: true, job }
  }
  catch (error) {
    console.error('Error starting the size chart intake:', error)
    return { success: false, error: error instanceof Error ? error.message : 'The intake could not start' }
  }
})

/**
 * Send approved charts to the website (the "Send approved charts" button):
 * every approved chart, every chart whose last sending failed, and every
 * chart already live — so products added since get it, and a product that
 * no longer carries the 1688 id loses it.
 *
 *   POST /api/size-charts/publish    body: { ids?: number[] }
 */

import { getAccessToken } from '../../utils/shopify'
import { createShopifyClientFromToken } from '../../utils/shopify-client-from-token'
import { clientForShop } from '../../utils/shop-tokens'
import { recordSendFailure, startPublishJob, whenIdle } from '../../utils/size-chart-jobs'

export default defineEventHandler(async (event) => {
  try {
    const { session } = await getAccessToken(event)
    if (!session.shop || !session.accessToken) throw new Error('No Shopify session for this request')
    const body = (await readBody(event).catch(() => null)) as { ids?: unknown } | null
    const chartIds = Array.isArray(body?.ids) ? body.ids.filter((id): id is number => Number.isInteger(id) && (id as number) > 0) : undefined
    const client = createShopifyClientFromToken(session.shop, session.accessToken, getRequestURL(event).host)
    const job = startPublishJob(client, { chartIds, includePublished: true })
    if (!job.started && job.alreadyRunning) {
      // Another job is running: this one starts by itself when it ends.
      const shop = session.shop
      whenIdle(async () => startPublishJob(await clientForShop(shop), { chartIds, includePublished: true }), error => recordSendFailure(chartIds, error))
      return { success: true, queued: true, job }
    }
    if (!job.started && job.reason) return { success: false, error: job.reason, job }
    return { success: true, job }
  }
  catch (error) {
    console.error('Error sending size charts to the website:', error)
    return { success: false, error: error instanceof Error ? error.message : 'The charts could not be sent' }
  }
})

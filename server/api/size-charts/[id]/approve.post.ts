/**
 * Approve a chart and put it on the website: on every product that carries
 * its 1688 id, each one checked again in Shopify first.
 *
 *   POST /api/size-charts/:id/approve    body: { note?: string }
 */

import { getAccessToken } from '../../../utils/shopify'
import { createShopifyClientFromToken } from '../../../utils/shopify-client-from-token'
import { clientForShop } from '../../../utils/shop-tokens'
import { approveChart, chartRowById } from '../../../utils/size-chart-store'
import { recordSendFailure, startPublishJob, whenIdle } from '../../../utils/size-chart-jobs'

export default defineEventHandler(async (event) => {
  try {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Which chart?' })
    const { session } = await getAccessToken(event)
    if (!session.shop || !session.accessToken) throw new Error('No Shopify session for this request')
    const shopHandle = session.shop.replace(/\.myshopify\.com$/i, '')
    const body = (await readBody(event).catch(() => null)) as { note?: unknown } | null
    const note = typeof body?.note === 'string' && body.note.trim() !== '' ? body.note.trim().slice(0, 500) : null
    const result = approveChart(id, session.shop, note)
    if (!result.ok) return { success: false, error: result.reason }

    const client = createShopifyClientFromToken(session.shop, session.accessToken, getRequestURL(event).host)
    const job = startPublishJob(client, { chartIds: [id] })
    let queued = false
    if (!job.started && job.alreadyRunning) {
      // Another job is running (a reading, a sync): the chart goes to the
      // website by itself the moment it ends.
      const shop = session.shop
      whenIdle(async () => startPublishJob(await clientForShop(shop), { chartIds: [id] }), error => recordSendFailure([id], error))
      queued = true
    }
    return { success: true, job, queued, row: chartRowById(id, shopHandle) }
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    console.error('Error on a size chart (approve):', error)
    return { success: false, error: error instanceof Error ? error.message : 'That did not work' }
  }
})

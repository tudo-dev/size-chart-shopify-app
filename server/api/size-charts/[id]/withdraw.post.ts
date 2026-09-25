/**
 * Take a chart off the website: off every product that shows it. The chart
 * is kept and goes back to "needs a look", so a person decides again.
 *
 * The request is written on the chart FIRST (requestWithdraw): from that
 * moment nothing sends the chart again, and a take-off a restart or a
 * refusal interrupted is picked up again by itself.
 *
 *   POST /api/size-charts/:id/withdraw
 */

import { getAccessToken } from '../../../utils/shopify'
import { createShopifyClientFromToken } from '../../../utils/shopify-client-from-token'
import { clientForShop } from '../../../utils/shop-tokens'
import { startWithdrawJob, whenIdle } from '../../../utils/size-chart-jobs'
import { chartRowById, requestWithdraw, updateChart } from '../../../utils/size-chart-store'

export default defineEventHandler(async (event) => {
  try {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Which chart?' })
    const { session } = await getAccessToken(event)
    if (!session.shop || !session.accessToken) throw new Error('No Shopify session for this request')
    const client = createShopifyClientFromToken(session.shop, session.accessToken, getRequestURL(event).host)
    const shopHandle = session.shop.replace(/\.myshopify\.com$/i, '')
    const asked = requestWithdraw(id, session.shop)
    if (!asked.ok) return { success: false, error: asked.reason }
    const job = startWithdrawJob(client, id)
    if (!job.started && job.alreadyRunning) {
      const shop = session.shop
      whenIdle(async () => startWithdrawJob(await clientForShop(shop), id), (error) => {
        updateChart(id, { error: `It could not be taken off the website: ${error instanceof Error ? error.message : String(error)}. Press Take off the website again.`.slice(0, 1000) })
      })
      return { success: true, queued: true, job, row: chartRowById(id, shopHandle) }
    }
    if (!job.started && job.reason) return { success: false, error: job.reason, job }
    return { success: true, job, row: chartRowById(id, shopHandle) }
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    console.error('Error taking a size chart off the website:', error)
    return { success: false, error: error instanceof Error ? error.message : 'The chart could not be taken off' }
  }
})

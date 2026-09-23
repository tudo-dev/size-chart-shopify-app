/**
 * Send a chart back to the queue to be fetched and read again.
 *
 *   POST /api/size-charts/:id/requeue
 */

import { getVerifiedShopUrl } from '../../../utils/shopify'
import { requeueChart, chartRowById } from '../../../utils/size-chart-store'

export default defineEventHandler(async (event) => {
  try {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Which chart?' })
    const shop = await getVerifiedShopUrl(event)
    if (!shop) throw createError({ statusCode: 401, statusMessage: 'Sign in to Shopify first.' })
    const result = requeueChart(id)
    if (!result.ok) return { success: false, error: result.reason }
    return { success: true, row: chartRowById(id, shop.replace(/\.myshopify\.com$/i, '')) }
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    console.error('Error on a size chart (requeue):', error)
    return { success: false, error: error instanceof Error ? error.message : 'That did not work' }
  }
})

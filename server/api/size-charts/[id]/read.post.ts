/**
 * Read (or read again) one chart's picture right now — the way the first
 * live picture is tried, and how a person asks for a second reading.
 *
 *   POST /api/size-charts/:id/read
 */

import { getVerifiedShopUrl } from '../../../utils/shopify'
import { chartById, chartRowById, requeueChart } from '../../../utils/size-chart-store'
import { startReadJob } from '../../../utils/size-chart-jobs'

export default defineEventHandler(async (event) => {
  try {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Which chart?' })
    const shop = await getVerifiedShopUrl(event)
    if (!shop) throw createError({ statusCode: 401, statusMessage: 'Sign in to Shopify first.' })
    const record = chartById(id)
    if (!record) return { success: false, error: 'That chart is not in the list any more.' }
    if (record.status !== 'queued') {
      const back = requeueChart(id)
      if (!back.ok) return { success: false, error: back.reason }
    }
    if (!record.imagePath) return { success: false, error: 'The picture has not been fetched yet. Press Sync products to fetch the missing pictures first.' }
    const job = startReadJob({ sourceIds: [record.sourceProductId] })
    const row = chartRowById(id, shop.replace(/\.myshopify\.com$/i, ''))
    if (!job.started && job.reason) return { success: false, error: job.reason, row }
    return { success: true, job, row }
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    console.error('Error reading a size chart:', error)
    return { success: false, error: error instanceof Error ? error.message : 'The reading could not start' }
  }
})

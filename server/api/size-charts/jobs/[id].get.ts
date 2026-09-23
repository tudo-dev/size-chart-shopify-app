/**
 * Progress of one size-chart job, for the page to poll.
 *
 *   GET /api/size-charts/jobs/:id
 */

import { getVerifiedShopUrl } from '../../../utils/shopify'
import { sizeChartJobById } from '../../../utils/size-chart-jobs'

export default defineEventHandler(async (event) => {
  try {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Which job?' })
    const shop = await getVerifiedShopUrl(event)
    if (!shop) throw createError({ statusCode: 401, statusMessage: 'Sign in to Shopify first.' })
    const job = sizeChartJobById(id)
    if (!job) throw createError({ statusCode: 404, statusMessage: 'No such job.' })
    return { success: true, job }
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load the job' }
  }
})

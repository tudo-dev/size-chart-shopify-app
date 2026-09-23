/**
 * One page of size charts.
 *
 *   GET /api/size-charts/list?view=review&q=hoodie&page=1&size=30
 *
 *   view  review (default: waiting for a person), all, queued, no-image,
 *         approved, published, failed, skipped, unmatched (no product found)
 *   q     a word to look for in the 1688 id, the product type, title or handle
 */

import { getVerifiedShopUrl } from '../../utils/shopify'
import { parseListQuery } from '../../utils/list-query'
import { CHART_VIEWS, listCharts } from '../../utils/size-chart-store'
import type { ChartView } from '../../utils/size-chart-store'

export default defineEventHandler(async (event) => {
  // Before the try: its catch answers every failure with a 200.
  const shop = await getVerifiedShopUrl(event)
  if (!shop) throw createError({ statusCode: 401, statusMessage: 'Sign in to Shopify first.' })
  try {
    const query = getQuery(event) as Record<string, unknown>
    const { page, size, q } = parseListQuery(query)
    const rawView = typeof query.view === 'string' ? query.view.trim() : ''
    const view: ChartView = (CHART_VIEWS as readonly string[]).includes(rawView) ? rawView as ChartView : 'review'
    const shopHandle = shop.replace(/\.myshopify\.com$/i, '')
    return { success: true, view, ...listCharts({ view, q, page, size, shopHandle }) }
  }
  catch (error) {
    console.error('Error listing size charts:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list the size charts' }
  }
})

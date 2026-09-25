/**
 * One size chart in full: the supplier's picture (as a data URL — the admin
 * page may not load pictures from 1688), the chart the app made from it as
 * an SVG, the reasons a person should look, and the products it belongs to.
 *
 *   GET /api/size-charts/:id
 */

import { getVerifiedShopUrl } from '../../utils/shopify'
import { chartById, chartRowById, parseChart, parseRead } from '../../utils/size-chart-store'
import { imageDataUrl } from '../../utils/size-chart-images'
import { renderChartSvg } from '../../../shared/size-chart/render-svg'
import { customerNotes } from '../../../shared/size-chart/chart'

export default defineEventHandler(async (event) => {
  try {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Which chart?' })
    const shop = await getVerifiedShopUrl(event)
    if (!shop) throw createError({ statusCode: 401, statusMessage: 'Sign in to Shopify first.' })
    const shopHandle = shop.replace(/\.myshopify\.com$/i, '')
    const record = chartById(id)
    const row = chartRowById(id, shopHandle)
    if (!record || !row) throw createError({ statusCode: 404, statusMessage: 'That chart is not in the list any more.' })
    const stored = parseChart(record.chartJson)
    // The notes as the website shows them, so the page never shows one the website leaves out.
    const chart = stored ? { ...stored, notes: customerNotes(stored.notes ?? []) } : null
    const title = row.products[0]?.title ?? `1688 product ${row.sourceProductId}`
    return {
      success: true,
      row,
      imageUrl: record.imageUrl,
      image: record.imagePath ? imageDataUrl(record.imagePath) : null,
      chart,
      read: parseRead(record.readJson),
      svg: chart ? renderChartSvg(chart, { title, subtitle: row.productType }) : null,
      readModel: record.readModel,
      tokensIn: record.tokensIn,
      tokensOut: record.tokensOut,
    }
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    console.error('Error loading a size chart:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load the chart' }
  }
})

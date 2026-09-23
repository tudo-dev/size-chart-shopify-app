/**
 * Approve a chart: it may go to Shopify at the next publish run.
 *
 *   POST /api/size-charts/:id/approve    body: { note?: string }
 */

import { getVerifiedShopUrl } from '../../../utils/shopify'
import { approveChart, chartRowById } from '../../../utils/size-chart-store'

export default defineEventHandler(async (event) => {
  try {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Which chart?' })
    const shop = await getVerifiedShopUrl(event)
    if (!shop) throw createError({ statusCode: 401, statusMessage: 'Sign in to Shopify first.' })
    const body = (await readBody(event).catch(() => null)) as { note?: unknown } | null
    const note = typeof body?.note === 'string' && body.note.trim() !== '' ? body.note.trim().slice(0, 500) : null
    const result = approveChart(id, shop, note)
    if (!result.ok) return { success: false, error: result.reason }
    return { success: true, row: chartRowById(id, shop.replace(/\.myshopify\.com$/i, '')) }
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    console.error('Error on a size chart (approve):', error)
    return { success: false, error: error instanceof Error ? error.message : 'That did not work' }
  }
})

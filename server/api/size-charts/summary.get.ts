/**
 * The Size charts page's first answer: how many charts stand where, whether
 * the product map is filled, the last upload and the last job.
 *
 *   GET /api/size-charts/summary
 */

import { getVerifiedShopUrl } from '../../utils/shopify'
import { countByStatus, latestUpload } from '../../utils/size-chart-store'
import { productSourceStats } from '../../utils/size-chart-products'
import { latestSizeChartJob } from '../../utils/size-chart-jobs'
import { countLiveProducts } from '../../utils/size-chart-publications'
import { themeEditorLink } from '../../utils/size-chart-theme'
import { DEFAULT_READER_MODEL, readerConfigFromEnv } from '../../utils/size-chart-reader'
import { getBooleanSetting, SETTING_SIZE_CHARTS_AUTO_APPROVE, SETTING_SIZE_CHARTS_AUTO_READ } from '../../utils/app-settings'

export default defineEventHandler(async (event) => {
  // Before the try: its catch answers every failure with a 200.
  const shop = await getVerifiedShopUrl(event)
  if (!shop) throw createError({ statusCode: 401, statusMessage: 'Sign in to Shopify first.' })
  try {
    const reader = readerConfigFromEnv()
    return {
      success: true,
      counts: countByStatus(),
      products: productSourceStats(),
      lastUpload: latestUpload(),
      lastJob: latestSizeChartJob(),
      // Whether a key is set, never the key itself.
      reader: { configured: reader !== null, model: reader?.model ?? DEFAULT_READER_MODEL },
      settings: { autoApprove: getBooleanSetting(SETTING_SIZE_CHARTS_AUTO_APPROVE, false), autoRead: getBooleanSetting(SETTING_SIZE_CHARTS_AUTO_READ, false) },
      // What customers can see now, and where the Size chart box is added.
      live: countLiveProducts(),
      box: { addToLiveTheme: themeEditorLink() },
    }
  }
  catch (error) {
    console.error('Error summarising size charts:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to load the size charts' }
  }
})

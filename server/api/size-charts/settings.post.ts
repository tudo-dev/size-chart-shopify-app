/**
 * Flip the size chart switch.
 *
 *   POST /api/size-charts/settings   { autoApprove?: boolean, autoRead?: boolean }
 *
 * `autoApprove` on lets the app approve a chart by itself when nothing at
 * all stood out in the reading. `autoRead` on lets an upload read its
 * pictures as soon as they are fetched. Both off by default; a chart with
 * even one flag waits for a person either way.
 */

import { getAccessToken } from '../../utils/shopify'
import { getBooleanSetting, setBooleanSetting, SETTING_SIZE_CHARTS_AUTO_APPROVE, SETTING_SIZE_CHARTS_AUTO_READ } from '../../utils/app-settings'

export default defineEventHandler(async (event) => {
  try {
    const { session } = await getAccessToken(event)
    if (!session.shop) throw new Error('No Shopify session for this request')
    const body = await readBody<{ autoApprove?: unknown, autoRead?: unknown }>(event)
    if (typeof body?.autoApprove !== 'boolean' && typeof body?.autoRead !== 'boolean') {
      throw createError({ statusCode: 400, statusMessage: 'Send autoApprove or autoRead as true or false.' })
    }
    if (typeof body.autoApprove === 'boolean') setBooleanSetting(SETTING_SIZE_CHARTS_AUTO_APPROVE, body.autoApprove)
    if (typeof body.autoRead === 'boolean') setBooleanSetting(SETTING_SIZE_CHARTS_AUTO_READ, body.autoRead)
    return {
      success: true,
      settings: {
        autoApprove: getBooleanSetting(SETTING_SIZE_CHARTS_AUTO_APPROVE),
        autoRead: getBooleanSetting(SETTING_SIZE_CHARTS_AUTO_READ),
      },
    }
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    console.error('Error saving the size chart settings:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to save the settings' }
  }
})

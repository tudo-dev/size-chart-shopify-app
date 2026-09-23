/**
 * Read every fetched picture that is still waiting (the "Read pictures"
 * button), including the ones whose last reading failed.
 *
 *   POST /api/size-charts/read
 */

import { getAccessToken } from '../../utils/shopify'
import { startReadJob } from '../../utils/size-chart-jobs'

export default defineEventHandler(async (event) => {
  try {
    const { session } = await getAccessToken(event)
    if (!session.shop) throw new Error('No Shopify session for this request')
    const job = startReadJob({ retryFailed: true })
    if (!job.started && job.reason) return { success: false, error: job.reason, job }
    return { success: true, job }
  }
  catch (error) {
    console.error('Error starting the size chart reading:', error)
    return { success: false, error: error instanceof Error ? error.message : 'The reading could not start' }
  }
})

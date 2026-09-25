/**
 * Upload the listing team's size-chart workbook.
 *
 *   POST /api/size-charts/upload      multipart: file (xlsx)
 *
 * Reads the "Size chart" tab (one row per 1688 product with the supplier's
 * picture link), folds it into the size-chart table — a new or changed link
 * queues the row, anything else only refreshes the words — and starts the
 * intake job: tie every row to its Shopify product, fetch every picture the
 * app has not got, then read them when the reader has a key. The workbook's
 * products-export tab, when present, gives the handles that make the matching
 * one cheap lookup per row.
 */

import { createHash } from 'node:crypto'
import { getAccessToken } from '../../utils/shopify'
import { createShopifyClientFromToken } from '../../utils/shopify-client-from-token'
import { openXlsxBuffer } from '../../../scripts/lib/xlsx'
import { parseSizeChartWorkbook } from '../../../scripts/lib/size-chart-sheet'
import { recordUpload, upsertSheetRows } from '../../utils/size-chart-store'
import { clientForShop } from '../../utils/shop-tokens'
import { startIntakeJob, startPublishJob, whenIdle } from '../../utils/size-chart-jobs'
import { getBooleanSetting, SETTING_SIZE_CHARTS_AUTO_READ } from '../../utils/app-settings'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export default defineEventHandler(async (event) => {
  try {
    const { session } = await getAccessToken(event)
    if (!session.shop || !session.accessToken) throw new Error('No Shopify session for this request')
    const parts = await readMultipartFormData(event)
    const file = parts?.find(part => part.name === 'file' && part.filename)
    if (!file || file.data.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Choose the size chart workbook first.' })
    }
    if (file.data.length > MAX_UPLOAD_BYTES) {
      throw createError({ statusCode: 413, statusMessage: 'That file is larger than 25 MB.' })
    }
    const isZip = file.data.length > 4 && file.data[0] === 0x50 && file.data[1] === 0x4B
    if (!isZip) {
      throw createError({ statusCode: 422, statusMessage: 'That is not an Excel workbook. In Google Sheets choose File, Download, Microsoft Excel (.xlsx).' })
    }
    const fileName = (file.filename ?? 'size-charts.xlsx').replace(/[^\w.() -]/g, '_')

    let parsed
    try {
      const workbook = openXlsxBuffer(file.data, fileName)
      parsed = parseSizeChartWorkbook(workbook.sheetNames.map(name => workbook.sheet(name)))
    }
    catch (error) {
      throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'The workbook could not be read.' })
    }

    const result = upsertSheetRows(parsed.rows)
    recordUpload({
      fileName,
      fileSha256: createHash('sha256').update(file.data).digest('hex'),
      uploadedBy: session.shop,
      rows: parsed.rows.length,
      added: result.added,
      changed: result.changed,
      unchanged: result.unchanged,
      noImage: result.noImage,
      skipped: parsed.skipped.length,
    })

    const handlesBySource = new Map<string, string[]>()
    for (const [sourceId, products] of parsed.products) handlesBySource.set(sourceId, products.map(product => product.handle))

    const client = createShopifyClientFromToken(session.shop, session.accessToken, getRequestURL(event).host)
    // Reading follows the fetch only when the switch on the page says so;
    // every reading costs money, so by default it is a separate press.
    const intakeInput = { handlesBySource, retryFailed: true, thenRead: getBooleanSetting(SETTING_SIZE_CHARTS_AUTO_READ, false) }
    const job = startIntakeJob(client, intakeInput)
    const shop = session.shop
    // Another job is running: the matching and fetching start by themselves
    // when it ends (the line is first in, first out, so before the check below).
    const queued = !job.started && job.alreadyRunning !== undefined
    if (queued) whenIdle(async () => startIntakeJob(await clientForShop(shop), intakeInput))
    // After the products are matched, charts already on the website reach any
    // new product with their 1688 id (only approved charts ever move).
    whenIdle(async () => startPublishJob(await clientForShop(shop), { includePublished: true }))

    return {
      success: true,
      fileName,
      sheetName: parsed.sheetName,
      productsSheetName: parsed.productsSheetName,
      rows: parsed.rows.length,
      withImage: parsed.rows.filter(row => row.imageUrl).length,
      added: result.added,
      changed: result.changed,
      unchanged: result.unchanged,
      noImage: result.noImage,
      toFetch: result.toFetch.length,
      skipped: parsed.skipped.length,
      skippedRows: parsed.skipped.slice(0, 20),
      job,
      queued,
    }
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    console.error('Error uploading the size chart workbook:', error)
    return { success: false, error: error instanceof Error ? error.message : 'The workbook could not be read.' }
  }
})

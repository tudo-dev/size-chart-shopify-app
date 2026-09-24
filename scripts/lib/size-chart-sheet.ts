/**
 * Reading the listing team's "Size chart" workbook.
 *
 * The sheet has one row per 1688 product: the 1688 id, the product type, the
 * store (MENS / WOMENS), the link to the supplier's size-chart picture, the
 * 1688 page link and a remark ("Not available" when the supplier shows none).
 * Google Sheets pads the tab to 1,000 rows and copies formulas down, so a row
 * counts only when it carries a 1688 id. The workbook may also carry a
 * Shopify product export tab; when it does, handle and title are read from it
 * so the app can name the product before Shopify has been asked.
 */

import type { XlsxSheet } from './xlsx'

export interface SizeChartSheetRow {
  rowNumber: number
  sourceProductId: string
  productType: string
  store: string
  imageUrl: string | null
  sourceUrl: string | null
  remark: string | null
}

export interface SheetProduct {
  handle: string
  title: string
  productType: string
  status: string
  sourceProductId: string
}

export interface ParsedSizeChartWorkbook {
  sheetName: string
  rows: SizeChartSheetRow[]
  /** Rows the sheet had that carry no 1688 id (padding, notes); counted, never kept. */
  skipped: { rowNumber: number, reason: string }[]
  /** From a products export tab in the same workbook, keyed by 1688 id. Empty when there is none. */
  products: Map<string, SheetProduct[]>
  productsSheetName: string | null
}

const ID_HEADING = 'Source Product ID'
const IMAGE_HEADING = '1688 Image link for Size chart'
const LINK_HEADING = '1688 Link'
const REMARK_HEADING = 'Remarks'
const STORE_HEADING = 'Store'
const TYPE_HEADING = 'Type'

/** "9.57039814706E11", "957039814706", "957039814706.0" → "957039814706"; anything else as typed. */
export function normaliseSourceProductId(raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  if (/^\d+$/.test(text)) return text
  if (/^[\d.]+e\+?\d+$/i.test(text) || /^\d+\.\d+$/.test(text)) {
    const n = Number(text)
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) return String(n)
  }
  return text
}

/** The offer id in a 1688 page link, or null. */
export function sourceIdFromUrl(url: string): string | null {
  const match = /1688\.com\/offer\/(\d+)/.exec(url)
  return match ? match[1]! : null
}

function findColumn(header: string[], startsWith: string): number {
  return header.findIndex(cell => cell.trim().toLowerCase().startsWith(startsWith.toLowerCase()))
}

function cleanUrl(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return null
  return /^https?:\/\//i.test(text) ? text : null
}

function looksLikeSizeChartSheet(sheet: XlsxSheet): number {
  return sheet.rows.findIndex(row => findColumn(row, ID_HEADING) !== -1 && findColumn(row, IMAGE_HEADING) !== -1)
}

function looksLikeProductsSheet(sheet: XlsxSheet): boolean {
  const header = sheet.rows[0] ?? []
  return header.some(cell => cell.trim() === 'Handle') && findColumn(header, ID_HEADING) !== -1
}

export function parseSizeChartWorkbook(sheets: readonly XlsxSheet[]): ParsedSizeChartWorkbook {
  let chartSheet: XlsxSheet | null = null
  let headerRow = -1
  for (const sheet of sheets) {
    const index = looksLikeSizeChartSheet(sheet)
    if (index !== -1) {
      chartSheet = sheet
      headerRow = index
      break
    }
  }
  if (!chartSheet) {
    throw new Error(`No sheet has the columns "${ID_HEADING}" and "${IMAGE_HEADING}". Sheets found: ${sheets.map(s => s.name).join(', ') || 'none'}.`)
  }

  const header = chartSheet.rows[headerRow]!
  const idCol = findColumn(header, ID_HEADING)
  const imageCol = findColumn(header, IMAGE_HEADING)
  const linkCol = findColumn(header, LINK_HEADING)
  const remarkCol = findColumn(header, REMARK_HEADING)
  const storeCol = findColumn(header, STORE_HEADING)
  const typeCol = findColumn(header, TYPE_HEADING)

  const rows: SizeChartSheetRow[] = []
  const skipped: { rowNumber: number, reason: string }[] = []
  const seen = new Map<string, number>()
  chartSheet.rows.forEach((row, index) => {
    if (index <= headerRow) return
    const rowNumber = index + 1
    const cell = (col: number) => (col === -1 ? '' : (row[col] ?? '')).trim()
    const link = cell(linkCol)
    let id = normaliseSourceProductId(cell(idCol))
    if (id === '') {
      const fromLink = link ? sourceIdFromUrl(link) : null
      if (fromLink) id = fromLink
    }
    if (id === '') {
      // Google Sheets copies the Store formula down to row 1,000, so a row
      // with only a store or tag in it is padding, not a product to report.
      const hasContent = link !== '' || cell(imageCol) !== '' || cell(remarkCol) !== ''
      if (hasContent) skipped.push({ rowNumber, reason: 'no 1688 product id' })
      return
    }
    if (!/^\d{6,}$/.test(id)) {
      skipped.push({ rowNumber, reason: `"${id}" is not a 1688 product id` })
      return
    }
    const linkId = link ? sourceIdFromUrl(link) : null
    if (linkId && linkId !== id) {
      skipped.push({ rowNumber, reason: `the id ${id} and the 1688 link (${linkId}) disagree` })
      return
    }
    const first = seen.get(id)
    if (first !== undefined) {
      skipped.push({ rowNumber, reason: `${id} is already on row ${first}` })
      return
    }
    seen.set(id, rowNumber)
    const remark = cell(remarkCol)
    rows.push({
      rowNumber,
      sourceProductId: id,
      productType: cell(typeCol),
      store: cell(storeCol).toUpperCase(),
      imageUrl: cleanUrl(cell(imageCol)),
      sourceUrl: cleanUrl(link) ?? `https://detail.1688.com/offer/${id}.html`,
      remark: remark === '' ? null : remark,
    })
  })

  const products = new Map<string, SheetProduct[]>()
  let productsSheetName: string | null = null
  const productsSheet = sheets.find(sheet => sheet !== chartSheet && looksLikeProductsSheet(sheet))
  if (productsSheet) {
    productsSheetName = productsSheet.name
    const pHeader = productsSheet.rows[0]!
    const handleCol = pHeader.findIndex(cell => cell.trim() === 'Handle')
    const titleCol = pHeader.findIndex(cell => cell.trim() === 'Title')
    const statusCol = pHeader.findIndex(cell => cell.trim() === 'Status')
    const pTypeCol = pHeader.findIndex(cell => cell.trim() === 'Type')
    const pIdCol = findColumn(pHeader, ID_HEADING)
    for (const row of productsSheet.rows.slice(1)) {
      const handle = (row[handleCol] ?? '').trim()
      const title = titleCol === -1 ? '' : (row[titleCol] ?? '').trim()
      // A Shopify export repeats the handle on every variant row; only the
      // first row of a product carries its title and metafields.
      if (handle === '' || title === '') continue
      const id = normaliseSourceProductId(row[pIdCol] ?? '')
      if (!/^\d{6,}$/.test(id)) continue
      const list = products.get(id) ?? []
      list.push({
        handle,
        title,
        productType: pTypeCol === -1 ? '' : (row[pTypeCol] ?? '').trim(),
        status: statusCol === -1 ? '' : (row[statusCol] ?? '').trim(),
        sourceProductId: id,
      })
      products.set(id, list)
    }
  }

  return { sheetName: chartSheet.name, rows, skipped, products, productsSheetName }
}

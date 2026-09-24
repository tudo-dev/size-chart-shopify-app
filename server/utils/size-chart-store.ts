/**
 * The size-chart table: what the sheet put there, what the reader found,
 * what a person decided, what Shopify was given.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import * as tables from '../db/schema'
import { useDb } from './db'
import { nowColumnText } from './time'
import type { SizeChartSheetRow } from '../../scripts/lib/size-chart-sheet'
import { chartSummary, sizesOf } from '../../shared/size-chart/chart'
import type { PublishedChart, ReadChart } from '../../shared/size-chart/chart'
import { productsForSources } from './size-chart-products'
import type { ProductSource } from './size-chart-products'
import { likePattern } from './list-query'

export const CHART_STATUSES = ['no-image', 'queued', 'image-failed', 'read-failed', 'needs-review', 'approved', 'publish-failed', 'published', 'skipped'] as const
export type ChartStatus = typeof CHART_STATUSES[number]

/** What the page's one dropdown offers. `review` is the default: the charts waiting for a person. */
export const CHART_VIEWS = ['review', 'all', 'queued', 'no-image', 'approved', 'published', 'failed', 'skipped', 'unmatched'] as const
export type ChartView = typeof CHART_VIEWS[number]

export const VIEW_STATUSES: Record<Exclude<ChartView, 'all' | 'unmatched'>, readonly ChartStatus[]> = {
  'review': ['needs-review'],
  'queued': ['queued'],
  'no-image': ['no-image'],
  'approved': ['approved'],
  'published': ['published'],
  'failed': ['image-failed', 'read-failed', 'publish-failed'],
  'skipped': ['skipped'],
}

export type ChartRecord = typeof tables.sizeCharts.$inferSelect

export interface ChartProduct {
  id: string
  handle: string
  title: string
  status: string | null
  adminUrl: string | null
}

export interface ChartRow {
  id: number
  sourceProductId: string
  sourceUrl: string | null
  productType: string | null
  store: string | null
  remark: string | null
  status: ChartStatus
  hasImage: boolean
  imageWidth: number | null
  imageHeight: number | null
  confidence: number | null
  flags: string[]
  notices: string[]
  summary: string | null
  sizes: string[]
  products: ChartProduct[]
  error: string | null
  readAt: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  reviewNote: string | null
  publishedAt: string | null
  shopifyImageUrl: string | null
  updatedAt: string
}

export interface UpsertResult {
  added: number
  changed: number
  unchanged: number
  noImage: number
  /** 1688 ids whose picture must be fetched now. */
  toFetch: string[]
}

/** https://admin.shopify.com/store/<shop>/products/<id> — the product in the admin. */
export function adminProductUrl(shopHandle: string | null, productGid: string): string | null {
  const numeric = productGid.replace('gid://shopify/Product/', '')
  if (!shopHandle || !/^\d+$/.test(numeric)) return null
  return `https://admin.shopify.com/store/${shopHandle}/products/${numeric}`
}

export function parseFlags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  }
  catch {
    return []
  }
}

export function parseChart(raw: string | null): PublishedChart | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PublishedChart
    return parsed && Array.isArray(parsed.tables) ? parsed : null
  }
  catch {
    return null
  }
}

export function parseRead(raw: string | null): ReadChart | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as ReadChart
  }
  catch {
    return null
  }
}

/** Fold the sheet into the table. A new picture link resets the row to `queued`; anything else only refreshes the words around it. */
export function upsertSheetRows(rows: readonly SizeChartSheetRow[], now = nowColumnText()): UpsertResult {
  const db = useDb()
  const result: UpsertResult = { added: 0, changed: 0, unchanged: 0, noImage: 0, toFetch: [] }
  for (const row of rows) {
    const existing = db.select().from(tables.sizeCharts).where(eq(tables.sizeCharts.sourceProductId, row.sourceProductId)).get()
    if (!existing) {
      db.insert(tables.sizeCharts).values({
        sourceProductId: row.sourceProductId,
        sourceUrl: row.sourceUrl,
        productType: row.productType || null,
        store: row.store || null,
        remark: row.remark,
        imageUrl: row.imageUrl,
        status: row.imageUrl ? 'queued' : 'no-image',
        createdAt: now,
        updatedAt: now,
      }).run()
      result.added++
      if (row.imageUrl) result.toFetch.push(row.sourceProductId)
      else result.noImage++
      continue
    }

    const words = {
      sourceUrl: row.sourceUrl ?? existing.sourceUrl,
      productType: row.productType || existing.productType,
      store: row.store || existing.store,
      remark: row.remark ?? existing.remark,
    }
    if (row.imageUrl && row.imageUrl !== existing.imageUrl) {
      db.update(tables.sizeCharts).set({
        ...words,
        imageUrl: row.imageUrl,
        imageSha256: null,
        imagePath: null,
        imageBytes: null,
        imageWidth: null,
        imageHeight: null,
        imageFetchedAt: null,
        status: 'queued',
        readJson: null,
        chartJson: null,
        flags: null,
        notices: null,
        confidence: null,
        readModel: null,
        readAt: null,
        tokensIn: null,
        tokensOut: null,
        reviewNote: null,
        reviewedBy: null,
        reviewedAt: null,
        error: null,
        updatedAt: now,
      }).where(eq(tables.sizeCharts.id, existing.id)).run()
      result.changed++
      result.toFetch.push(row.sourceProductId)
      continue
    }

    const wordsChanged = words.sourceUrl !== existing.sourceUrl || words.productType !== existing.productType
      || words.store !== existing.store || words.remark !== existing.remark
    if (wordsChanged) db.update(tables.sizeCharts).set({ ...words, updatedAt: now }).where(eq(tables.sizeCharts.id, existing.id)).run()
    result.unchanged++
    if (!existing.imageUrl && !row.imageUrl) result.noImage++
    if (existing.status === 'queued' && !existing.imagePath) result.toFetch.push(row.sourceProductId)
  }
  return result
}

export function recordUpload(input: {
  fileName: string
  fileSha256: string
  uploadedBy: string | null
  rows: number
  added: number
  changed: number
  unchanged: number
  noImage: number
  skipped: number
  now?: string
}): number {
  return useDb().insert(tables.sizeChartUploads).values({
    fileName: input.fileName,
    fileSha256: input.fileSha256,
    uploadedBy: input.uploadedBy,
    rows: input.rows,
    added: input.added,
    changed: input.changed,
    unchanged: input.unchanged,
    noImage: input.noImage,
    skipped: input.skipped,
    createdAt: input.now ?? nowColumnText(),
  }).returning({ id: tables.sizeChartUploads.id }).get().id
}

export function latestUpload() {
  return useDb().select().from(tables.sizeChartUploads).orderBy(desc(tables.sizeChartUploads.id)).get() ?? null
}

const unmatchedClause: SQL = sql`not exists (select 1 from shopify_product_source p where p.source_product_id = ${tables.sizeCharts.sourceProductId})`

function viewClause(view: ChartView): SQL | null {
  if (view === 'all') return null
  if (view === 'unmatched') return unmatchedClause
  return inArray(tables.sizeCharts.status, [...VIEW_STATUSES[view]])
}

function searchClause(q: string): SQL | null {
  if (q === '') return null
  const pattern = likePattern(q)
  return sql`(${tables.sizeCharts.sourceProductId} like ${pattern} escape '\\'
    or coalesce(${tables.sizeCharts.productType}, '') like ${pattern} escape '\\'
    or exists (select 1 from shopify_product_source p
               where p.source_product_id = ${tables.sizeCharts.sourceProductId}
                 and (p.title like ${pattern} escape '\\' or p.handle like ${pattern} escape '\\')))`
}

function toRow(record: ChartRecord, products: readonly ProductSource[], shopHandle: string | null): ChartRow {
  const chart = parseChart(record.chartJson)
  return {
    id: record.id,
    sourceProductId: record.sourceProductId,
    sourceUrl: record.sourceUrl,
    productType: record.productType,
    store: record.store,
    remark: record.remark,
    status: record.status as ChartStatus,
    hasImage: record.imageUrl !== null,
    imageWidth: record.imageWidth,
    imageHeight: record.imageHeight,
    confidence: record.confidence,
    flags: parseFlags(record.flags),
    notices: parseFlags(record.notices),
    summary: chart ? chartSummary(chart) : null,
    sizes: chart ? sizesOf(chart) : [],
    products: products.map(product => ({
      id: product.shopifyProductId,
      handle: product.handle,
      title: product.title,
      status: product.status,
      adminUrl: adminProductUrl(shopHandle, product.shopifyProductId),
    })),
    error: record.error,
    readAt: record.readAt,
    reviewedAt: record.reviewedAt,
    reviewedBy: record.reviewedBy,
    reviewNote: record.reviewNote,
    publishedAt: record.publishedAt,
    shopifyImageUrl: record.shopifyImageUrl,
    updatedAt: record.updatedAt,
  }
}

export interface ListInput {
  view: ChartView
  q: string
  page: number
  size: number
  shopHandle: string | null
}

export function listCharts(input: ListInput): { rows: ChartRow[], total: number, page: number, size: number } {
  const db = useDb()
  const clauses = [viewClause(input.view), searchClause(input.q.trim())].filter((clause): clause is SQL => clause !== null)
  const where = clauses.length === 0 ? undefined : and(...clauses)
  const total = db.select({ n: sql<number>`count(*)` }).from(tables.sizeCharts).where(where).get()?.n ?? 0
  const records = db.select().from(tables.sizeCharts).where(where)
    .orderBy(desc(tables.sizeCharts.updatedAt), desc(tables.sizeCharts.id))
    .limit(input.size).offset((input.page - 1) * input.size)
    .all()
  const products = productsForSources(records.map(record => record.sourceProductId))
  return {
    rows: records.map(record => toRow(record, products.get(record.sourceProductId) ?? [], input.shopHandle)),
    total,
    page: input.page,
    size: input.size,
  }
}

export function chartById(id: number): ChartRecord | null {
  return useDb().select().from(tables.sizeCharts).where(eq(tables.sizeCharts.id, id)).get() ?? null
}

export function chartRowById(id: number, shopHandle: string | null): ChartRow | null {
  const record = chartById(id)
  if (!record) return null
  const products = productsForSources([record.sourceProductId]).get(record.sourceProductId) ?? []
  return toRow(record, products, shopHandle)
}

/** Another row that shows the very same picture and has already been read — its transcript can be reused without asking the reader again. */
export function readForImage(imageSha256: string, exceptId: number): ChartRecord | null {
  return useDb().select().from(tables.sizeCharts)
    .where(and(eq(tables.sizeCharts.imageSha256, imageSha256), sql`${tables.sizeCharts.readJson} is not null`, sql`${tables.sizeCharts.id} != ${exceptId}`))
    .orderBy(desc(tables.sizeCharts.readAt))
    .get() ?? null
}

export function chartsWithStatus(statuses: readonly ChartStatus[], sourceIds?: readonly string[]): ChartRecord[] {
  const clauses: SQL[] = [inArray(tables.sizeCharts.status, [...statuses])]
  if (sourceIds && sourceIds.length > 0) clauses.push(inArray(tables.sizeCharts.sourceProductId, [...sourceIds]))
  return useDb().select().from(tables.sizeCharts).where(and(...clauses)).orderBy(tables.sizeCharts.id).all()
}

export function countByStatus(): Record<ChartStatus, number> & { total: number, unmatched: number } {
  const db = useDb()
  const counts = Object.fromEntries(CHART_STATUSES.map(status => [status, 0])) as Record<ChartStatus, number>
  for (const row of db.select({ status: tables.sizeCharts.status, n: sql<number>`count(*)` }).from(tables.sizeCharts).groupBy(tables.sizeCharts.status).all()) {
    if ((CHART_STATUSES as readonly string[]).includes(row.status)) counts[row.status as ChartStatus] = row.n
  }
  const total = db.select({ n: sql<number>`count(*)` }).from(tables.sizeCharts).get()?.n ?? 0
  const unmatched = db.select({ n: sql<number>`count(*)` }).from(tables.sizeCharts).where(unmatchedClause).get()?.n ?? 0
  return { ...counts, total, unmatched }
}

/** The 1688 ids in the table that no product on record carries. */
export function unmatchedSourceIds(): string[] {
  return useDb().select({ id: tables.sizeCharts.sourceProductId }).from(tables.sizeCharts).where(unmatchedClause).all().map(row => row.id)
}

export function updateChart(id: number, patch: Partial<typeof tables.sizeCharts.$inferInsert>, now = nowColumnText()): void {
  useDb().update(tables.sizeCharts).set({ ...patch, updatedAt: now }).where(eq(tables.sizeCharts.id, id)).run()
}

export function markImageFetched(id: number, image: { sha256: string, path: string, bytes: number, width: number | null, height: number | null }, now = nowColumnText()): void {
  updateChart(id, {
    imageSha256: image.sha256,
    imagePath: image.path,
    imageBytes: image.bytes,
    imageWidth: image.width,
    imageHeight: image.height,
    imageFetchedAt: now,
    error: null,
  }, now)
}

export function markFailed(id: number, status: 'image-failed' | 'read-failed' | 'publish-failed', error: string, now = nowColumnText()): void {
  updateChart(id, { status, error: error.slice(0, 1000) }, now)
}

export function markRead(id: number, input: {
  read: ReadChart
  chart: PublishedChart
  flags: string[]
  notices: string[]
  confidence: number
  autoApprove: boolean
  model: string
  tokensIn: number | null
  tokensOut: number | null
}, now = nowColumnText()): ChartStatus {
  const status: ChartStatus = input.autoApprove ? 'approved' : 'needs-review'
  updateChart(id, {
    readJson: JSON.stringify(input.read),
    chartJson: JSON.stringify(input.chart),
    flags: JSON.stringify(input.flags),
    notices: JSON.stringify(input.notices),
    confidence: input.confidence,
    readModel: input.model,
    readAt: now,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    status,
    error: null,
    reviewedBy: input.autoApprove ? 'app' : null,
    reviewedAt: input.autoApprove ? now : null,
    reviewNote: null,
  }, now)
  return status
}

export function approveChart(id: number, by: string | null, note: string | null, now = nowColumnText()): { ok: true } | { ok: false, reason: string } {
  const record = chartById(id)
  if (!record) return { ok: false, reason: 'That chart is not in the list any more.' }
  if (!record.chartJson) return { ok: false, reason: 'This picture has not been read yet, so there is nothing to approve.' }
  if (record.status === 'published') return { ok: false, reason: 'This chart is already on the website.' }
  updateChart(id, { status: 'approved', reviewedBy: by, reviewedAt: now, reviewNote: note, error: null }, now)
  return { ok: true }
}

export function skipChart(id: number, by: string | null, note: string | null, now = nowColumnText()): { ok: true } | { ok: false, reason: string } {
  const record = chartById(id)
  if (!record) return { ok: false, reason: 'That chart is not in the list any more.' }
  if (record.status === 'published') return { ok: false, reason: 'This chart is already on the website; take it down there first.' }
  updateChart(id, { status: 'skipped', reviewedBy: by, reviewedAt: now, reviewNote: note }, now)
  return { ok: true }
}

/** Back to the queue: the picture is fetched again if it never arrived, and read again in any case. */
export function requeueChart(id: number, now = nowColumnText()): { ok: true } | { ok: false, reason: string } {
  const record = chartById(id)
  if (!record) return { ok: false, reason: 'That chart is not in the list any more.' }
  if (!record.imageUrl) return { ok: false, reason: 'The sheet has no picture link for this product, so there is nothing to read.' }
  if (record.status === 'published') return { ok: false, reason: 'This chart is already on the website. Upload a sheet with a new picture link to replace it.' }
  updateChart(id, {
    status: 'queued',
    readJson: null,
    chartJson: null,
    flags: null,
    notices: null,
    confidence: null,
    readAt: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    error: null,
  }, now)
  return { ok: true }
}

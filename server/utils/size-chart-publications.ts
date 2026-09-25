/**
 * The app's own record of which chart is on which product in Shopify
 * (`size_chart_publication`). Written only after Shopify confirmed a write
 * and read it back; removed only after Shopify confirmed the removal.
 */

import { eq, inArray, sql } from 'drizzle-orm'
import * as tables from '../db/schema'
import { useDb } from './db'

export type PublicationRecord = typeof tables.sizeChartPublications.$inferSelect

/**
 * Charts Shopify is being talked to about right now (sent or taken off).
 * While a chart is here, a person's Skip or Read again waits a few seconds
 * instead of racing the job, so the job never overwrites their decision.
 */
const inFlight = new Set<number>()

export function markInFlight(chartId: number): void {
  inFlight.add(chartId)
}

export function clearInFlight(chartId: number): void {
  inFlight.delete(chartId)
}

export function isInFlight(chartId: number): boolean {
  return inFlight.has(chartId)
}

/** Charts that still have at least one product showing them. */
export function chartIdsWithPublications(): number[] {
  return useDb().selectDistinct({ id: tables.sizeChartPublications.chartId }).from(tables.sizeChartPublications).all().map(row => row.id)
}

export function publicationsForCharts(chartIds: readonly number[]): Map<number, PublicationRecord[]> {
  const map = new Map<number, PublicationRecord[]>()
  if (chartIds.length === 0) return map
  const rows = useDb().select().from(tables.sizeChartPublications)
    .where(inArray(tables.sizeChartPublications.chartId, [...chartIds]))
    .orderBy(tables.sizeChartPublications.publishedAt, tables.sizeChartPublications.shopifyProductId)
    .all()
  for (const row of rows) {
    const list = map.get(row.chartId) ?? []
    list.push(row)
    map.set(row.chartId, list)
  }
  return map
}

export function publicationForProduct(shopifyProductId: string): PublicationRecord | null {
  return useDb().select().from(tables.sizeChartPublications).where(eq(tables.sizeChartPublications.shopifyProductId, shopifyProductId)).get() ?? null
}

/** How many products show a chart now, and how many charts that is. */
export function countLiveProducts(): { products: number, charts: number } {
  const row = useDb().select({
    products: sql<number>`count(*)`,
    charts: sql<number>`count(distinct ${tables.sizeChartPublications.chartId})`,
  }).from(tables.sizeChartPublications).get()
  return { products: row?.products ?? 0, charts: row?.charts ?? 0 }
}

export function savePublication(row: Omit<PublicationRecord, 'publishedAt' | 'checkedAt'>, changed: boolean, now: string): void {
  const existing = publicationForProduct(row.shopifyProductId)
  // "On the website since" moves only when the chart on the product changed.
  const publishedAt = changed || !existing || existing.chartId !== row.chartId ? now : existing.publishedAt
  useDb().insert(tables.sizeChartPublications)
    .values({ ...row, publishedAt, checkedAt: now })
    .onConflictDoUpdate({
      target: tables.sizeChartPublications.shopifyProductId,
      set: { ...row, publishedAt, checkedAt: now },
    })
    .run()
}

export function removePublication(shopifyProductId: string): void {
  useDb().delete(tables.sizeChartPublications).where(eq(tables.sizeChartPublications.shopifyProductId, shopifyProductId)).run()
}

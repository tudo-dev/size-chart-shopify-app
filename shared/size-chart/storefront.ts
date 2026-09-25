/**
 * The chart as the website gets it, and the checks it must pass first.
 *
 * The product-page box (extensions/size-chart/blocks/size-chart.liquid) only
 * prints: every figure arrives here as finished text in both systems, so the
 * page shows exactly what a person approved and never does arithmetic.
 *
 * Shopify's limits decide the checks (shopify.dev, read 2026-09-25): a json
 * metafield holds at most 128 KB for apps that started using json after
 * 1 April 2026, which this app did; and a Liquid `for` loop is not trusted
 * past 50 turns, so no list here may be longer than that.
 */

import { createHash } from 'node:crypto'
import { customerNotes } from './chart'
import type { PublishedChart, PublishedColumn, PublishedTable } from './chart'

/** Where the chart lives on each product. `$app:` makes it this app's own: merchants see it read-only and no other app can change it. */
export const CHART_METAFIELD_NAMESPACE = '$app:size_chart'
export const CHART_METAFIELD_KEY = 'chart'
export const CHART_METAFIELD_TYPE = 'json'

export const STOREFRONT_LIMITS = {
  maxBytes: 128 * 1024,
  maxTables: 50,
  maxColumns: 50,
  maxRows: 50,
  maxNotes: 50,
} as const

/**
 * One size, as the website gets it. The size is called `label`, not `size`:
 * in Liquid `size` is also the length of any list or object, so a key of
 * that name could print a count instead of the size.
 */
export interface StorefrontRow {
  label: string
  metric: string[]
  imperial: string[]
}

export interface StorefrontTable {
  title: string
  /** The first column is always Size; its unit is null. */
  columns: PublishedColumn[]
  rows: StorefrontRow[]
}

export interface StorefrontChart {
  v: 1
  /** True when some figure differs between inches and centimetres, so the page offers the switch. */
  units: boolean
  tables: StorefrontTable[]
  notes: string[]
}

function tableHasUnits(table: PublishedTable): boolean {
  if (table.columns.some(column => column.metric !== column.imperial)) return true
  return table.rows.some(row => row.metric.some((value, index) => value !== row.imperial[index]))
}

/** Call only on a chart that passed storefrontProblems. */
export function toStorefrontChart(chart: PublishedChart): StorefrontChart {
  return {
    v: 1,
    units: chart.tables.some(tableHasUnits),
    tables: chart.tables.map(table => ({
      title: table.title,
      columns: table.columns.map(column => ({ label: column.label, metric: column.metric, imperial: column.imperial })),
      rows: table.rows.map(row => ({ label: row.size, metric: row.metric, imperial: row.imperial })),
    })),
    // Charts read before the rule may still hold "all measurements are in mm".
    notes: customerNotes(chart.notes ?? []),
  }
}

/**
 * Every reason this chart may not go to the website, in plain words. Empty
 * means it is fit to show. A chart that fails here is never half-sent.
 */
export function storefrontProblems(chart: PublishedChart | null): string[] {
  if (!chart || !Array.isArray(chart.tables)) return ['The chart could not be read back from the app\'s own record.']
  const problems: string[] = []
  if (chart.tables.length === 0) problems.push('The chart has no table to show.')
  if (chart.tables.length > STOREFRONT_LIMITS.maxTables) problems.push(`The chart has ${chart.tables.length} tables; the website shows at most ${STOREFRONT_LIMITS.maxTables}.`)
  if ((chart.notes ?? []).length > STOREFRONT_LIMITS.maxNotes) problems.push(`The chart has ${chart.notes.length} notes; the website shows at most ${STOREFRONT_LIMITS.maxNotes}.`)
  chart.tables.forEach((table, tableIndex) => {
    const name = `Table ${tableIndex + 1} ("${table?.title ?? ''}")`
    if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
      problems.push(`${name} is damaged in the app's record.`)
      return
    }
    const cells = table.columns.length - 1
    if (table.columns.length < 2) problems.push(`${name} has no measurement columns.`)
    if (table.columns.length > STOREFRONT_LIMITS.maxColumns) problems.push(`${name} has ${table.columns.length} columns; the website shows at most ${STOREFRONT_LIMITS.maxColumns}.`)
    if (table.rows.length === 0) problems.push(`${name} has no sizes.`)
    if (table.rows.length > STOREFRONT_LIMITS.maxRows) problems.push(`${name} has ${table.rows.length} sizes; the website shows at most ${STOREFRONT_LIMITS.maxRows}.`)
    table.rows.forEach((row) => {
      if (!row || typeof row !== 'object') {
        problems.push(`${name} has a damaged row.`)
        return
      }
      if (typeof row.size !== 'string' || row.size.trim() === '') problems.push(`${name} has a row with no size.`)
      if (!Array.isArray(row.metric) || !Array.isArray(row.imperial) || row.metric.length !== cells || row.imperial.length !== cells) {
        problems.push(`${name}, size "${row.size}": the figures do not line up with the headings.`)
      }
    })
  })
  // Measured only on a chart whose shape is sound: the conversion below
  // assumes every row lines up with its headings.
  if (problems.length === 0) {
    const bytes = Buffer.byteLength(JSON.stringify(toStorefrontChart(chart)), 'utf8')
    if (bytes > STOREFRONT_LIMITS.maxBytes) problems.push(`The chart is ${Math.ceil(bytes / 1024)} KB; Shopify holds at most ${STOREFRONT_LIMITS.maxBytes / 1024} KB.`)
  }
  return problems
}

/** The exact text sent to Shopify, and its fingerprint, so an unchanged chart is never sent twice. */
export function storefrontValue(chart: PublishedChart): { json: string, sha256: string } {
  const json = JSON.stringify(toStorefrontChart(chart))
  return { json, sha256: createHash('sha256').update(json).digest('hex') }
}

/**
 * Which Shopify product a 1688 id belongs to.
 *
 * Shopify cannot search products by a metafield, so the app keeps its own
 * copy of every product's 1688 id (`shopify_product_source`), filled two
 * ways: by handle, when the uploaded workbook carries the products export
 * (one cheap lookup per row, checked against the product's own metafield),
 * and by walking the whole catalogue when a row's product is still unknown.
 * Several products may share one 1688 id; every one of them gets the chart.
 */

import type { GraphqlClient } from '@shopify/shopify-api'
import { eq, inArray, sql } from 'drizzle-orm'
import * as tables from '../db/schema'
import { useDb } from './db'
import { nowColumnText } from './time'

export const SOURCE_ID_NAMESPACE = 'external'
export const SOURCE_ID_KEY = 'source_product_id'
export const SOURCE_URL_KEY = 'source_product_url'

const PAGE = 100
const HANDLES_PER_QUERY = 20

export interface ProductSource {
  shopifyProductId: string
  handle: string
  title: string
  productType: string | null
  status: string | null
  sourceProductId: string
  sourceUrl: string | null
  /** JSON string[] of the product's Size option values, as the shop sells them. Null when it has none. */
  sizeOptions: string | null
}

interface ProductNode {
  id: string
  handle: string
  title: string
  productType: string | null
  status: string | null
  source: { value: string } | null
  sourceUrl: { value: string } | null
  options?: { name: string, optionValues?: { name: string }[] }[] | null
}

/** Names Shopify's size option goes by, lower-cased. */
const SIZE_OPTION_NAMES = ['size', 'shoe size', 'सा इज', 'साइज']

/**
 * The values of the product's Size option, in the order the shop lists them.
 *
 * This is what a customer actually picks, so it is what the first column of
 * a size chart has to say. Without it a shoe chart printed sideways gets its
 * size column from whichever row the supplier put first — a foot length in
 * centimetres, say, which no customer can choose.
 */
export function sizeOptionsOf(node: Pick<ProductNode, 'options'>): string[] | null {
  const option = (node.options ?? []).find(candidate => SIZE_OPTION_NAMES.includes((candidate.name ?? '').trim().toLowerCase()))
  if (!option) return null
  const values = (option.optionValues ?? []).map(value => (value.name ?? '').trim()).filter(value => value !== '')
  return values.length > 0 ? values : null
}

interface Throttle { currentlyAvailable?: number, restoreRate?: number }

/** "957039814706", or the id inside the `{"text":"","url":"https://detail.1688.com/offer/957039814706.html"}` link metafield. */
export function normaliseMetafieldSourceId(value: string | null | undefined): string | null {
  if (!value) return null
  const text = value.trim()
  if (/^\d{6,}$/.test(text)) return text
  const asNumber = Number(text)
  if (Number.isFinite(asNumber) && Number.isInteger(asNumber) && asNumber > 0) return String(asNumber)
  const inUrl = /1688\.com\/offer\/(\d+)/.exec(text)
  return inUrl ? inUrl[1]! : null
}

/** The plain page link out of a link-type metafield, or the value itself when it is already a link. */
export function sourceUrlFromMetafield(value: string | null | undefined): string | null {
  if (!value) return null
  const text = value.trim()
  if (/^https?:\/\//i.test(text)) return text
  try {
    const parsed = JSON.parse(text) as { url?: string }
    return typeof parsed.url === 'string' && /^https?:\/\//i.test(parsed.url) ? parsed.url : null
  }
  catch {
    return null
  }
}

function toSource(node: ProductNode): ProductSource | null {
  const sourceProductId = normaliseMetafieldSourceId(node.source?.value)
  if (!sourceProductId) return null
  const sizes = sizeOptionsOf(node)
  return {
    shopifyProductId: node.id,
    handle: node.handle,
    title: node.title,
    productType: node.productType || null,
    status: node.status || null,
    sourceProductId,
    sourceUrl: sourceUrlFromMetafield(node.sourceUrl?.value),
    sizeOptions: sizes ? JSON.stringify(sizes) : null,
  }
}

/** The sizes a product is sold in, from the stored JSON. */
export function sizesSoldOf(source: Pick<ProductSource, 'sizeOptions'> | null | undefined): string[] {
  if (!source?.sizeOptions) return []
  try {
    const parsed = JSON.parse(source.sizeOptions) as unknown
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  }
  catch {
    return []
  }
}

const NODE_FIELDS = `
  id handle title productType status
  options(first: 5) { name optionValues { name } }
  source: metafield(namespace: "${SOURCE_ID_NAMESPACE}", key: "${SOURCE_ID_KEY}") { value }
  sourceUrl: metafield(namespace: "${SOURCE_ID_NAMESPACE}", key: "${SOURCE_URL_KEY}") { value }
`

export function saveProductSources(sources: readonly ProductSource[], now = nowColumnText()): void {
  if (sources.length === 0) return
  const db = useDb()
  for (const source of sources) {
    db.insert(tables.shopifyProductSources)
      .values({ ...source, syncedAt: now })
      .onConflictDoUpdate({
        target: tables.shopifyProductSources.shopifyProductId,
        set: {
          handle: source.handle,
          title: source.title,
          productType: source.productType,
          status: source.status,
          sourceProductId: source.sourceProductId,
          sourceUrl: source.sourceUrl,
          sizeOptions: source.sizeOptions,
          syncedAt: now,
        },
      })
      .run()
  }
}

/** The products on record for each of these 1688 ids. */
export function productsForSources(sourceIds: readonly string[]): Map<string, ProductSource[]> {
  const map = new Map<string, ProductSource[]>()
  if (sourceIds.length === 0) return map
  const rows = useDb().select().from(tables.shopifyProductSources)
    .where(inArray(tables.shopifyProductSources.sourceProductId, [...sourceIds]))
    .all()
  for (const row of rows) {
    const list = map.get(row.sourceProductId) ?? []
    list.push(row)
    map.set(row.sourceProductId, list)
  }
  return map
}

export function productSourceStats(): { products: number, lastSyncedAt: string | null } {
  const row = useDb().select({
    products: sql<number>`count(*)`,
    lastSyncedAt: sql<string | null>`max(synced_at)`,
  }).from(tables.shopifyProductSources).get()
  return { products: row?.products ?? 0, lastSyncedAt: row?.lastSyncedAt ?? null }
}

/** Wait for Shopify's bucket when a page took more than it has left; the answer's own cost figures say how long. */
async function respectThrottle(extensions: unknown, sleep: (ms: number) => Promise<void>): Promise<void> {
  const cost = (extensions as { cost?: { requestedQueryCost?: number, throttleStatus?: Throttle } } | undefined)?.cost
  const status = cost?.throttleStatus
  if (!status || !Number.isFinite(status.currentlyAvailable) || !Number.isFinite(status.restoreRate) || !status.restoreRate) return
  const need = (cost?.requestedQueryCost ?? 0) * 1.2
  if ((status.currentlyAvailable ?? 0) >= need) return
  const wait = Math.ceil((need - (status.currentlyAvailable ?? 0)) / status.restoreRate * 1000)
  await sleep(Math.min(wait, 15_000))
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Look these handles up in Shopify and record every product that carries a
 * 1688 id. Returns the handles Shopify did not know.
 */
export async function syncProductsByHandle(
  client: GraphqlClient,
  handles: readonly string[],
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ found: ProductSource[], missing: string[], withoutSource: string[] }> {
  const sleep = deps.sleep ?? defaultSleep
  const found: ProductSource[] = []
  const missing: string[] = []
  const withoutSource: string[] = []
  const unique = [...new Set(handles.map(h => h.trim()).filter(h => h !== ''))]
  for (let at = 0; at < unique.length; at += HANDLES_PER_QUERY) {
    const batch = unique.slice(at, at + HANDLES_PER_QUERY)
    const fields = batch.map((handle, index) => `p${index}: productByIdentifier(identifier: { handle: ${JSON.stringify(handle)} }) { ${NODE_FIELDS} }`).join('\n')
    const response = await client.request(`query ProductsByHandle { ${fields} }`) as { data?: Record<string, ProductNode | null>, extensions?: unknown }
    const batchFound: ProductSource[] = []
    batch.forEach((handle, index) => {
      const node = response.data?.[`p${index}`] ?? null
      if (!node) {
        missing.push(handle)
        return
      }
      const source = toSource(node)
      if (source) batchFound.push(source)
      else withoutSource.push(handle)
    })
    found.push(...batchFound)
    saveProductSources(batchFound)
    await respectThrottle(response.extensions, sleep)
  }
  return { found, missing, withoutSource }
}

/**
 * Walk the whole catalogue and record every product that carries a 1688 id.
 * `onPage` hears the running total so a job can show progress.
 */
export async function syncAllProductSources(
  client: GraphqlClient,
  deps: { sleep?: (ms: number) => Promise<void>, onPage?: (seen: number, withSource: number) => void } = {},
): Promise<{ seen: number, withSource: number }> {
  const sleep = deps.sleep ?? defaultSleep
  const now = nowColumnText()
  let after: string | null = null
  let seen = 0
  let withSource = 0
  for (;;) {
    const response = await client.request(
      `query ProductsWithSource($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: ID) {
          pageInfo { hasNextPage endCursor }
          nodes { ${NODE_FIELDS} }
        }
      }`,
      { variables: { first: PAGE, after } },
    ) as { data?: { products?: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: ProductNode[] } }, extensions?: unknown }
    const page = response.data?.products
    if (!page) throw new Error('Shopify did not answer the product list')
    const sources: ProductSource[] = []
    for (const node of page.nodes) {
      seen++
      const source = toSource(node)
      if (source) sources.push(source)
    }
    withSource += sources.length
    saveProductSources(sources, now)
    deps.onPage?.(seen, withSource)
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break
    after = page.pageInfo.endCursor
    await respectThrottle(response.extensions, sleep)
  }
  return { seen, withSource }
}

/** Products recorded before this sync began that the sync did not see again are gone (deleted) — drop them. */
export function dropProductSourcesOlderThan(syncStartedAt: string): number {
  const result = useDb().delete(tables.shopifyProductSources)
    .where(sql`${tables.shopifyProductSources.syncedAt} < ${syncStartedAt}`)
    .run()
  return result.changes
}

export function productSourceById(shopifyProductId: string): ProductSource | null {
  return useDb().select().from(tables.shopifyProductSources).where(eq(tables.shopifyProductSources.shopifyProductId, shopifyProductId)).get() ?? null
}

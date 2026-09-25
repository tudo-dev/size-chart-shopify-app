/**
 * Putting an approved chart on its products in Shopify, and taking it off.
 *
 * How a chart reaches the RIGHT product: the sheet's 1688 id is matched to
 * every product whose `external.source_product_id` holds that id (the app's
 * own map, `shopify_product_source`). Before anything is written, each of
 * those products is read live from Shopify and its 1688 id checked again; a
 * product that no longer carries the id never gets the chart, and loses it
 * if it had it. The chart is then saved ON that product (ownerId = the
 * product's id), where the product-page box reads it. A product page can
 * therefore only ever show a chart saved on that very product.
 *
 * Every write is conditional (compareDigest) and read back; the
 * publication table records only what Shopify confirmed.
 *
 * The Shopify formats are the ones shopify.dev documents for Admin API
 * 2026-07 (checked 2026-09-25). Two things the docs leave open are proven at
 * run time instead of assumed: the namespace Shopify gives the app's own
 * `$app:size_chart` (read from the definition), and that the chart reads
 * back under it (every write is read back before it counts).
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import * as tables from '../db/schema'
import { useDb } from './db'
import { nowColumnText } from './time'
import { CHART_METAFIELD_KEY, CHART_METAFIELD_NAMESPACE, CHART_METAFIELD_TYPE, storefrontProblems, storefrontValue } from '../../shared/size-chart/storefront'
import { normaliseMetafieldSourceId, productsForSources, SOURCE_ID_KEY, SOURCE_ID_NAMESPACE } from './size-chart-products'
import { chartIdsWithPublications, clearInFlight, markInFlight, publicationForProduct, publicationsForCharts, removePublication, savePublication } from './size-chart-publications'
import type { PublicationRecord } from './size-chart-publications'
import { chartById, parseChart, updateChart } from './size-chart-store'
import type { ChartRecord, ChartStatus } from './size-chart-store'

/** What the publisher needs from a Shopify client — the real GraphqlClient has it, and so does the test's fake. */
export interface GraphqlRequester {
  request: (query: string, options?: { variables?: Record<string, unknown>, retries?: number }) => Promise<{ data?: unknown }>
}

/** The client library retries a failed connection this many times by itself. */
const RETRIES = 2

/** Shopify's "too many requests right now": wait and ask again, a few times, before calling it a failure. */
const THROTTLE_TRIES = 4
const THROTTLE_WAIT_MS = 1_000

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function isThrottled(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${JSON.stringify((error as { response?: unknown }).response ?? '')}` : String(error)
  return /throttl/i.test(text)
}

/**
 * The same client, asking again when Shopify says it is busy. A GraphQL
 * throttle arrives as an error in a normal answer, which the library's own
 * retries (for broken connections) do not cover.
 */
export function patientClient(client: GraphqlRequester, sleep: (ms: number) => Promise<void> = defaultSleep): GraphqlRequester {
  return {
    request: async (query, options) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await client.request(query, options)
        }
        catch (error) {
          if (!isThrottled(error) || attempt >= THROTTLE_TRIES) throw error
          await sleep(THROTTLE_WAIT_MS * attempt)
        }
      }
    },
  }
}

/**
 * Shopify took a chart but it did not read back the same. That would mean
 * the app cannot see what customers see, so the whole run stops at once
 * (after putting that product back) instead of sending more charts blind.
 */
export class ReadBackError extends Error {}

/** A product Shopify no longer has comes out of the product map too, so it is never tried again. */
function forgetProduct(shopifyProductId: string): void {
  useDb().delete(tables.shopifyProductSources).where(eq(tables.shopifyProductSources.shopifyProductId, shopifyProductId)).run()
}

/* ------------------------------------------------------------------ */
/* Shopify: the definition                                             */
/* ------------------------------------------------------------------ */

const DEFINITION_QUERY = `query SizeChartDefinition {
  metafieldDefinitions(first: 10, ownerType: PRODUCT, key: "${CHART_METAFIELD_KEY}") {
    nodes { id namespace key type { name } access { admin storefront } }
  }
}`

const DEFINITION_CREATE = `mutation CreateSizeChartDefinition($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id namespace key type { name } access { admin storefront } }
    userErrors { field message code }
  }
}`

/** `$app:size_chart` as Shopify stores it: app--<the app's number>--size_chart. */
export function isChartNamespace(namespace: string | null | undefined): boolean {
  return typeof namespace === 'string' && (/^app--\d+--size_chart$/.test(namespace) || namespace === CHART_METAFIELD_NAMESPACE)
}

interface DefinitionNode { id: string, namespace: string, key: string, type?: { name?: string } | null, access?: { admin?: string, storefront?: string } | null }

async function findDefinition(client: GraphqlRequester): Promise<DefinitionNode | null> {
  const response = await client.request(DEFINITION_QUERY, { retries: RETRIES })
  const nodes = (response.data as { metafieldDefinitions?: { nodes?: DefinitionNode[] } } | undefined)?.metafieldDefinitions?.nodes ?? []
  return nodes.find(node => node.key === CHART_METAFIELD_KEY && isChartNamespace(node.namespace)) ?? null
}

/**
 * Make sure Shopify knows the chart field before any chart is written: typed
 * json, read-only for staff in the admin, readable by the storefront. Safe
 * to run before every job. Returns the namespace as Shopify stores it, which
 * the app then uses to read charts back.
 */
export async function ensureChartDefinition(client: GraphqlRequester): Promise<string> {
  const found = await findDefinition(client)
  if (found) return found.namespace
  const response = await client.request(DEFINITION_CREATE, {
    retries: RETRIES,
    variables: {
      definition: {
        name: 'Size chart',
        namespace: CHART_METAFIELD_NAMESPACE,
        key: CHART_METAFIELD_KEY,
        type: CHART_METAFIELD_TYPE,
        ownerType: 'PRODUCT',
        description: 'Written by Tudoholic Size Charts; shown by its Size chart box on the product page.',
        access: { admin: 'MERCHANT_READ', storefront: 'PUBLIC_READ' },
      },
    },
  })
  const result = (response.data as { metafieldDefinitionCreate?: { createdDefinition?: DefinitionNode | null, userErrors?: { message: string, code?: string }[] } } | undefined)?.metafieldDefinitionCreate
  const created = result?.createdDefinition
  if (created && isChartNamespace(created.namespace)) return created.namespace
  // TAKEN: another run made it a moment ago. Anything else is a real refusal.
  const again = await findDefinition(client)
  if (again) return again.namespace
  const why = (result?.userErrors ?? []).map(error => error.message).join('; ') || 'no reason given'
  throw new Error(`Shopify would not create the size chart field on products: ${why}`)
}

/* ------------------------------------------------------------------ */
/* Shopify: one product                                                */
/* ------------------------------------------------------------------ */

export interface LiveProduct {
  id: string
  handle: string
  title: string
  status: string | null
  onlineStoreUrl: string | null
  templateSuffix: string | null
  /** The 1688 id the product carries now, normalised; null when it has none. */
  sourceProductId: string | null
  chart: { value: string, compareDigest: string | null } | null
}

const PRODUCT_QUERY = `query ProductChartState($id: ID!, $namespace: String!) {
  product(id: $id) {
    id handle title status onlineStoreUrl templateSuffix
    source: metafield(namespace: "${SOURCE_ID_NAMESPACE}", key: "${SOURCE_ID_KEY}") { value }
    chart: metafield(namespace: $namespace, key: "${CHART_METAFIELD_KEY}") { value compareDigest }
  }
}`

/** The product as Shopify has it right now, or null when Shopify no longer has it. */
export async function readLiveProduct(client: GraphqlRequester, productId: string, namespace: string): Promise<LiveProduct | null> {
  const response = await client.request(PRODUCT_QUERY, { retries: RETRIES, variables: { id: productId, namespace } })
  const node = (response.data as { product?: {
    id: string
    handle: string
    title: string
    status?: string | null
    onlineStoreUrl?: string | null
    templateSuffix?: string | null
    source?: { value?: string | null } | null
    chart?: { value?: string | null, compareDigest?: string | null } | null
  } | null } | undefined)?.product
  if (!node) return null
  return {
    id: node.id,
    handle: node.handle,
    title: node.title,
    status: node.status ?? null,
    onlineStoreUrl: node.onlineStoreUrl ?? null,
    templateSuffix: node.templateSuffix ? node.templateSuffix : null,
    sourceProductId: normaliseMetafieldSourceId(node.source?.value ?? null),
    chart: typeof node.chart?.value === 'string' ? { value: node.chart.value, compareDigest: node.chart.compareDigest ?? null } : null,
  }
}

const SET_MUTATION = `mutation SetSizeChart($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key owner { ... on Product { id } } }
    userErrors { field message code elementIndex }
  }
}`

export type WriteResult = { ok: true } | { ok: false, reason: string, changedMeanwhile: boolean }

/**
 * Save the chart on one product. `compareDigest` is ALWAYS sent: null means
 * "only if the product has no chart yet", a digest means "only if nobody
 * changed it since I read it". Left out, Shopify would skip that safety
 * check — so it is never left out.
 */
export async function writeChartMetafield(client: GraphqlRequester, productId: string, json: string, compareDigest: string | null): Promise<WriteResult> {
  const response = await client.request(SET_MUTATION, {
    retries: RETRIES,
    variables: {
      metafields: [{
        ownerId: productId,
        namespace: CHART_METAFIELD_NAMESPACE,
        key: CHART_METAFIELD_KEY,
        type: CHART_METAFIELD_TYPE,
        value: json,
        compareDigest,
      }],
    },
  })
  const result = (response.data as { metafieldsSet?: {
    metafields?: { owner?: { id?: string } | null }[] | null
    userErrors?: { message: string, code?: string | null }[]
  } } | undefined)?.metafieldsSet
  const errors = result?.userErrors ?? []
  if (errors.length > 0) {
    const changedMeanwhile = errors.some(error => error.code === 'INVALID_COMPARE_DIGEST' || error.code === 'STALE_OBJECT')
    return { ok: false, reason: errors.map(error => error.message).join('; '), changedMeanwhile }
  }
  const owner = result?.metafields?.[0]?.owner?.id
  if (owner !== productId) return { ok: false, reason: 'Shopify did not confirm the chart was saved on this product.', changedMeanwhile: false }
  return { ok: true }
}

const DELETE_MUTATION = `mutation RemoveSizeChart($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) {
    deletedMetafields { ownerId namespace key }
    userErrors { field message }
  }
}`

/** Take the chart off one product. Nothing there to take off counts as done. */
export async function deleteChartMetafield(client: GraphqlRequester, productId: string, namespace: string): Promise<{ ok: true } | { ok: false, reason: string }> {
  const response = await client.request(DELETE_MUTATION, {
    retries: RETRIES,
    variables: { metafields: [{ ownerId: productId, namespace, key: CHART_METAFIELD_KEY }] },
  })
  const result = (response.data as { metafieldsDelete?: { userErrors?: { message: string }[] } } | undefined)?.metafieldsDelete
  const errors = result?.userErrors ?? []
  if (errors.length > 0) return { ok: false, reason: errors.map(error => error.message).join('; ') }
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* One chart                                                           */
/* ------------------------------------------------------------------ */

export interface ProductOutcome {
  productId: string
  title: string
  reason: string
}

export interface PublishOutcome {
  chartId: number
  status: ChartStatus
  /** Products that got the chart now. */
  written: number
  /** Products that already showed exactly this chart. */
  unchanged: number
  /** Products the chart was taken off because they no longer carry its 1688 id. */
  removed: number
  skipped: ProductOutcome[]
  failed: ProductOutcome[]
  /**
   * Products the app could not look at just now, although they show (or may
   * show) this chart: a check that failed, not a product Shopify refused.
   * They do not make a live chart "fail"; the next check looks again.
   */
  unchecked: ProductOutcome[]
  error: string | null
  /**
   * A person (or a new sheet) changed the chart while it was being sent. The
   * run stopped there and left their decision exactly as they made it; the
   * products already reached stay on the record, because they show it.
   */
  interrupted: boolean
}

const PUBLISHABLE: readonly ChartStatus[] = ['approved', 'publish-failed', 'published']

function sentence(list: readonly ProductOutcome[]): string {
  const shown = list.slice(0, 3).map(item => `${item.title}: ${item.reason}`).join('; ')
  return list.length > 3 ? `${shown}; and ${list.length - 3} more` : shown
}

function sameValue(column: typeof tables.sizeCharts.chartJson | typeof tables.sizeCharts.imageUrl | typeof tables.sizeCharts.withdrawRequestedAt, value: string | null) {
  return value === null ? isNull(column) : eq(column, value)
}

/** The chart row is still what the run started from: same status, same reading, same picture, no take-off asked for. */
function unchangedSince(snapshot: ChartRecord): boolean {
  const current = chartById(snapshot.id)
  return !!current && current.status === snapshot.status && current.chartJson === snapshot.chartJson
    && current.imageUrl === snapshot.imageUrl && current.withdrawRequestedAt === snapshot.withdrawRequestedAt
}

/**
 * Write the chart row only if nobody changed it since the run read it. A
 * Skip, a Read again, a new picture from the sheet or a take-off always wins
 * over a run that was already under way. Returns whether it wrote.
 */
function updateIfUnchanged(snapshot: ChartRecord, patch: Partial<typeof tables.sizeCharts.$inferInsert>, now: string): boolean {
  const result = useDb().update(tables.sizeCharts).set({ ...patch, updatedAt: now }).where(and(
    eq(tables.sizeCharts.id, snapshot.id),
    eq(tables.sizeCharts.status, snapshot.status),
    sameValue(tables.sizeCharts.chartJson, snapshot.chartJson),
    sameValue(tables.sizeCharts.imageUrl, snapshot.imageUrl),
    sameValue(tables.sizeCharts.withdrawRequestedAt, snapshot.withdrawRequestedAt),
  )).run()
  return result.changes > 0
}

/** How many products show exactly this reading of the chart now, by the app's record. */
function liveCount(chartId: number, sha256: string): number {
  return (publicationsForCharts([chartId]).get(chartId) ?? []).filter(publication => publication.chartSha256 === sha256).length
}

const UNCHECKED = 'Shopify took the chart, but the app could not check it just now; the next check looks again'
const MAYBE_TAKEN = 'Shopify may have taken the chart, but the app could not check it just now; the next check looks again'
const NOT_CHECKED = 'the app could not check it just now; it still shows this chart, and the next check looks again'
const CHECK_PREFIX = 'The older chart still on the website could not be checked'

/**
 * Put one approved chart on every product that carries its 1688 id, and
 * take it off any product that no longer does. Safe to run again at any
 * time: a product that already shows this exact chart is left alone.
 *
 * A chart that is not approved but still shows on products (an older
 * reading, while a new picture waits) is only CHECKED: it comes off a
 * product that no longer carries its id or was deleted, and nothing is
 * ever written.
 */
export async function publishChart(client: GraphqlRequester, record: ChartRecord, namespace: string, now = nowColumnText()): Promise<PublishOutcome> {
  const outcome: PublishOutcome = { chartId: record.id, status: record.status as ChartStatus, written: 0, unchanged: 0, removed: 0, skipped: [], failed: [], unchecked: [], error: null, interrupted: false }
  if (record.withdrawRequestedAt) return { ...outcome, error: 'It is being taken off the website, so it is not sent.' }
  if (!PUBLISHABLE.includes(record.status as ChartStatus)) {
    const live = publicationsForCharts([record.id]).get(record.id) ?? []
    if (live.length > 0) return recheckLiveOnly(client, record, live, namespace, now)
    return { ...outcome, error: 'Only an approved chart can go to the website.' }
  }
  const fail = (error: string): PublishOutcome => {
    const wrote = updateIfUnchanged(record, { status: 'publish-failed', error: error.slice(0, 1000) }, now)
    return { ...outcome, status: wrote ? 'publish-failed' : outcome.status, error, interrupted: !wrote }
  }

  const chart = parseChart(record.chartJson)
  const problems = storefrontProblems(chart)
  if (problems.length > 0) return fail(`This chart cannot go to the website: ${problems.slice(0, 3).join(' ')}`)
  const { json, sha256 } = storefrontValue(chart!)

  const mapped = productsForSources([record.sourceProductId]).get(record.sourceProductId) ?? []
  const already = publicationsForCharts([record.id]).get(record.id) ?? []
  const candidates = [...new Set([...mapped.map(product => product.shopifyProductId), ...already.map(publication => publication.shopifyProductId)])]
  if (candidates.length === 0) {
    return fail(`No product in the store carries the 1688 id ${record.sourceProductId}. Press Sync products, then send it again.`)
  }

  markInFlight(record.id)
  try {
    for (const productId of candidates) {
      // A person's decision made while this run was talking to Shopify wins.
      if (!unchangedSince(record)) {
        outcome.interrupted = true
        break
      }
      const known = mapped.find(product => product.shopifyProductId === productId)
      const title = known?.title ?? already.find(publication => publication.shopifyProductId === productId)?.title ?? productId
      let sent = false
      let publication: Omit<PublicationRecord, 'publishedAt' | 'checkedAt'> | null = null
      try {
        let live = await readLiveProduct(client, productId, namespace)
        if (!live) {
          removePublication(productId)
          forgetProduct(productId)
          outcome.skipped.push({ productId, title, reason: 'the product is no longer in the store' })
          continue
        }

        if (live.sourceProductId !== record.sourceProductId) {
          // The product does not carry this chart's 1688 id (any more), so it
          // must not show this chart. If this chart is what it shows, it comes off.
          const mine = publicationForProduct(productId)
          if (live.chart && mine?.chartId === record.id) {
            const removed = await deleteChartMetafield(client, productId, namespace)
            if (!removed.ok) {
              outcome.failed.push({ productId, title: live.title, reason: `it no longer carries this 1688 id, and the old chart could not be taken off (${removed.reason})` })
              continue
            }
            outcome.removed++
          }
          if (mine?.chartId === record.id) removePublication(productId)
          outcome.skipped.push({ productId, title: live.title, reason: live.sourceProductId ? `it now carries the 1688 id ${live.sourceProductId}` : 'it no longer carries a 1688 id' })
          continue
        }

        publication = {
          shopifyProductId: productId,
          chartId: record.id,
          sourceProductId: record.sourceProductId,
          chartSha256: sha256,
          handle: live.handle,
          title: live.title,
          onlineStoreUrl: live.onlineStoreUrl,
          templateSuffix: live.templateSuffix,
        }

        if (live.chart?.value === json) {
          savePublication(publication, false, now)
          outcome.unchanged++
          continue
        }

        sent = true
        let written = await writeChartMetafield(client, productId, json, live.chart?.compareDigest ?? null)
        if (!written.ok && written.changedMeanwhile) {
          // Someone changed it between the read and the write: read again and try once more.
          live = await readLiveProduct(client, productId, namespace)
          if (live && live.sourceProductId === record.sourceProductId) {
            written = await writeChartMetafield(client, productId, json, live.chart?.compareDigest ?? null)
          }
        }
        if (!written.ok) {
          sent = false
          outcome.failed.push({ productId, title, reason: written.reason })
          continue
        }
        // Shopify confirmed it saved the chart on this product: from here on
        // customers may see it, so the record says so before anything else.
        savePublication(publication, true, now)

        let check: LiveProduct | null
        try {
          check = await readLiveProduct(client, productId, namespace)
        }
        catch {
          outcome.unchecked.push({ productId, title, reason: UNCHECKED })
          continue
        }
        if (!check || check.chart?.value !== json) {
          // Take it off again, then stop the whole run. Once it is off, the
          // record must not say anything is live there. If it could not be
          // taken off, the row stays, so "Take off the website" reaches it.
          let undone = await deleteChartMetafield(client, productId, namespace).catch(() => ({ ok: false as const, reason: 'no answer' }))
          if (!undone.ok) undone = await deleteChartMetafield(client, productId, CHART_METAFIELD_NAMESPACE).catch(() => ({ ok: false as const, reason: 'no answer' }))
          if (undone.ok) removePublication(productId)
          const reason = undone.ok
            ? 'Shopify accepted the chart but it did not read back the same, so it was taken off again and nothing more was sent'
            : 'Shopify accepted the chart but it did not read back the same, and it could not be taken off again; use Take off the website'
          outcome.failed.push({ productId, title, reason })
          fail(`It did not reach ${title}: ${reason}.`)
          throw new ReadBackError(`The chart for ${title} did not read back from Shopify; the run stopped so no chart goes live unseen.`)
        }
        savePublication({ ...publication, handle: check.handle, title: check.title, onlineStoreUrl: check.onlineStoreUrl, templateSuffix: check.templateSuffix }, false, now)
        outcome.written++
      }
      catch (error) {
        if (error instanceof ReadBackError) throw error
        if (sent && publication) {
          // The write went out and no answer came back: Shopify may have it.
          // Look once more; if even that fails, the record says it may be
          // live, so a take-off still reaches it and the next send checks it.
          try {
            const again = await readLiveProduct(client, productId, namespace)
            if (again?.chart?.value === json) {
              savePublication(publication, true, now)
              outcome.written++
              continue
            }
          }
          catch {
            savePublication(publication, true, now)
            outcome.unchecked.push({ productId, title, reason: MAYBE_TAKEN })
            continue
          }
        }
        // A product that already shows exactly this chart and could only not
        // be looked at just now has not "failed": it still shows it.
        const mine = publicationForProduct(productId)
        if (!sent && mine?.chartId === record.id && mine.chartSha256 === sha256) {
          outcome.unchecked.push({ productId, title, reason: NOT_CHECKED })
          continue
        }
        outcome.failed.push({ productId, title, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  finally {
    clearInFlight(record.id)
  }

  if (outcome.interrupted) return outcome
  const liveNow = liveCount(record.id, sha256)
  const notChecked = outcome.unchecked.length > 0 ? ` Could not check just now: ${sentence(outcome.unchecked)}.` : ''
  if (outcome.failed.length > 0) {
    const reached = liveNow > 0 ? ` It is on ${liveNow} ${liveNow === 1 ? 'product' : 'products'}.` : ''
    return fail(`It did not reach ${outcome.failed.length === 1 ? 'one product' : `${outcome.failed.length} products`}: ${sentence(outcome.failed)}.${reached}${notChecked} Send it again to retry.`)
  }
  if (liveNow === 0) {
    return fail(`None of the products carries the 1688 id ${record.sourceProductId} any more (${sentence(outcome.skipped)}). Press Sync products, then send it again.`)
  }
  // Only checks were missing: the chart is on the website; say what could
  // not be looked at, and let the next check clear it.
  const note = notChecked === '' ? null : notChecked.trim().slice(0, 1000)
  // A re-check that found everything as it was changes nothing, so the row
  // keeps its place in the list and its "on the website since" date.
  const nothingNew = record.status === 'published' && outcome.written === 0 && outcome.removed === 0
    && record.publishedSha256 === sha256 && record.error === note
  if (!nothingNew) {
    const wrote = updateIfUnchanged(record, { status: 'published', publishedAt: outcome.written > 0 || !record.publishedAt ? now : record.publishedAt, publishedSha256: sha256, error: note }, now)
    if (!wrote) return { ...outcome, interrupted: true }
  }
  return { ...outcome, status: 'published', error: note }
}

/**
 * An older reading still on the website while a new picture waits: never
 * written, only kept honest. It comes off a product that no longer carries
 * the 1688 id, and a product Shopify deleted leaves the record.
 */
async function recheckLiveOnly(client: GraphqlRequester, record: ChartRecord, live: readonly PublicationRecord[], namespace: string, now: string): Promise<PublishOutcome> {
  const outcome: PublishOutcome = { chartId: record.id, status: record.status as ChartStatus, written: 0, unchanged: 0, removed: 0, skipped: [], failed: [], unchecked: [], error: null, interrupted: false }
  markInFlight(record.id)
  try {
    for (const publication of live) {
      const productId = publication.shopifyProductId
      const title = publication.title ?? productId
      try {
        const product = await readLiveProduct(client, productId, namespace)
        if (!product) {
          removePublication(productId)
          forgetProduct(productId)
          outcome.skipped.push({ productId, title, reason: 'the product is no longer in the store' })
          continue
        }
        if (product.sourceProductId !== record.sourceProductId) {
          if (product.chart) {
            const removed = await deleteChartMetafield(client, productId, namespace)
            if (!removed.ok) {
              outcome.failed.push({ productId, title: product.title, reason: `it no longer carries this 1688 id, and the old chart could not be taken off (${removed.reason})` })
              continue
            }
            outcome.removed++
          }
          removePublication(productId)
          outcome.skipped.push({ productId, title: product.title, reason: product.sourceProductId ? `it now carries the 1688 id ${product.sourceProductId}` : 'it no longer carries a 1688 id' })
          continue
        }
        if (!product.chart) {
          // Someone removed it in Shopify: the record follows.
          removePublication(productId)
          continue
        }
        savePublication({ ...publication, handle: product.handle, title: product.title, onlineStoreUrl: product.onlineStoreUrl, templateSuffix: product.templateSuffix }, false, now)
        outcome.unchanged++
      }
      catch (error) {
        outcome.failed.push({ productId, title, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  finally {
    clearInFlight(record.id)
  }
  // The chart's own reason (a picture that could not be fetched or read)
  // belongs to it and stays; this check only ever writes, and clears, its own.
  const ownReason = record.error && !record.error.startsWith(CHECK_PREFIX) ? record.error : null
  if (outcome.failed.length > 0) {
    const error = `${CHECK_PREFIX} on ${outcome.failed.length === 1 ? 'one product' : `${outcome.failed.length} products`}: ${sentence(outcome.failed)}.`
    if (!ownReason) updateIfUnchanged(record, { error: error.slice(0, 1000) }, now)
    return { ...outcome, error }
  }
  if (record.error?.startsWith(CHECK_PREFIX)) updateIfUnchanged(record, { error: null }, now)
  return outcome
}

export interface WithdrawOutcome {
  chartId: number
  removed: number
  failed: ProductOutcome[]
  error: string | null
}

/**
 * Take a chart off every product that shows it. Run it after
 * requestWithdraw (which has already moved the chart out of reach of every
 * send). Once Shopify confirms it is off everywhere, the request is closed;
 * if any product refused, the request stays open and is tried again.
 */
export async function withdrawChart(client: GraphqlRequester, record: ChartRecord, namespace: string, now = nowColumnText()): Promise<WithdrawOutcome> {
  const outcome: WithdrawOutcome = { chartId: record.id, removed: 0, failed: [], error: null }
  // Only an open request is carried out: a take-off that already finished
  // (and a chart approved again since) must never be undone by a leftover one.
  if (!chartById(record.id)?.withdrawRequestedAt) return outcome
  const publications = publicationsForCharts([record.id]).get(record.id) ?? []
  markInFlight(record.id)
  try {
    for (const publication of publications) {
      const title = publication.title ?? publication.shopifyProductId
      try {
        const removed = await deleteChartMetafield(client, publication.shopifyProductId, namespace)
        if (!removed.ok) {
          outcome.failed.push({ productId: publication.shopifyProductId, title, reason: removed.reason })
          continue
        }
        const check = await readLiveProduct(client, publication.shopifyProductId, namespace)
        if (check?.chart) {
          outcome.failed.push({ productId: publication.shopifyProductId, title, reason: 'Shopify still shows a chart on it' })
          continue
        }
        removePublication(publication.shopifyProductId)
        outcome.removed++
      }
      catch (error) {
        outcome.failed.push({ productId: publication.shopifyProductId, title, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  finally {
    clearInFlight(record.id)
  }

  if (outcome.failed.length > 0) {
    const error = `It could not be taken off ${outcome.failed.length === 1 ? 'one product' : `${outcome.failed.length} products`}: ${sentence(outcome.failed)}. Press Take off the website again.`
    updateChart(record.id, { error: error.slice(0, 1000) }, now)
    return { ...outcome, error }
  }
  updateChart(record.id, { withdrawRequestedAt: null, publishedAt: null, publishedSha256: null, error: null }, now)
  return outcome
}

/**
 * The charts a publish run takes: the approved ones, the ones that failed,
 * and, to reach new products and keep old ones honest, every chart still
 * showing somewhere. Never a chart someone asked to take off.
 */
export function chartsToPublish(input: { chartIds?: readonly number[], includePublished?: boolean } = {}): ChartRecord[] {
  const statuses: ChartStatus[] = input.includePublished ? ['approved', 'publish-failed', 'published'] : ['approved', 'publish-failed']
  const liveIds = input.includePublished ? chartIdsWithPublications() : []
  const which = liveIds.length > 0 ? or(inArray(tables.sizeCharts.status, statuses), inArray(tables.sizeCharts.id, liveIds))! : inArray(tables.sizeCharts.status, statuses)
  const clauses = [which, isNull(tables.sizeCharts.withdrawRequestedAt)]
  if (input.chartIds && input.chartIds.length > 0) clauses.push(inArray(tables.sizeCharts.id, [...input.chartIds]))
  return useDb().select().from(tables.sizeCharts).where(and(...clauses)).orderBy(tables.sizeCharts.id).all()
}

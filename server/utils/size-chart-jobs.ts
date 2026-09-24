/**
 * Size-chart jobs: one at a time per process, the row written before the
 * work starts, a crash recorded on the row, progress the page can poll.
 *
 * `intake` runs after every upload: tie the sheet's 1688 ids to Shopify
 * products (by handle when the workbook had the export tab, by walking the
 * catalogue when a product is still unknown), then fetch every picture the
 * app has not got yet. Reading and publishing are their own jobs.
 */

import { readFileSync } from 'node:fs'
import type { GraphqlClient } from '@shopify/shopify-api'
import { desc, eq } from 'drizzle-orm'
import pLimit from 'p-limit'
import * as tables from '../db/schema'
import { useDb } from './db'
import { nowColumnText } from './time'
import { normaliseChart } from '../../shared/size-chart/chart'
import { getBooleanSetting, SETTING_SIZE_CHARTS_AUTO_APPROVE } from './app-settings'
import { fetchImage, imageKindOf, mediaTypeOf } from './size-chart-images'
import { dropProductSourcesOlderThan, productsForSources, sizesSoldOf, syncAllProductSources, syncProductsByHandle } from './size-chart-products'
import { readerConfigFromEnv, readSizeChartImage } from './size-chart-reader'
import type { ReaderConfig, ReadInput, ReadResult } from './size-chart-reader'
import { chartsWithStatus, markFailed, markImageFetched, markRead, parseRead, readForImage, unmatchedSourceIds, updateChart } from './size-chart-store'

export type JobKind = 'intake' | 'read' | 'publish'

export interface JobHandle {
  id: number
  progress: (patch: { done?: number, failed?: number, total?: number, note?: string | null }) => void
}

export interface StartJobResult {
  /** Null when no job was made (nothing to do, or the reader has no key). */
  jobId: number | null
  started: boolean
  alreadyRunning?: number
  /** Why nothing started, in plain words, when `started` is false and no job is running. */
  reason?: string
}

const IMAGE_CONCURRENCY = 3
const READ_CONCURRENCY = 2

let running: number | null = null

export function sizeChartJobById(id: number) {
  return useDb().select().from(tables.sizeChartJobs).where(eq(tables.sizeChartJobs.id, id)).get() ?? null
}

export function latestSizeChartJob(kind?: JobKind) {
  const db = useDb()
  const query = kind
    ? db.select().from(tables.sizeChartJobs).where(eq(tables.sizeChartJobs.kind, kind))
    : db.select().from(tables.sizeChartJobs)
  return query.orderBy(desc(tables.sizeChartJobs.id)).get() ?? null
}

/**
 * `then` runs once the work has finished and the lock is released (the
 * intake uses it to start the reading), never after a crash.
 */
export function launchSizeChartJob(kind: JobKind, total: number, work: (job: JobHandle) => Promise<void>, then?: () => void): StartJobResult {
  const db = useDb()
  const now = nowColumnText()

  if (running !== null && sizeChartJobById(running)?.status === 'running') {
    return { jobId: running, started: false, alreadyRunning: running }
  }
  running = null

  // A job left `running` by a restart is finished for it: its work is on the
  // rows already, and the next job picks up whatever is still queued.
  db.update(tables.sizeChartJobs)
    .set({ status: 'failed', error: 'the app restarted while this job was running; the next job continues from where it stopped', finishedAt: now })
    .where(eq(tables.sizeChartJobs.status, 'running'))
    .run()

  const job = db.insert(tables.sizeChartJobs).values({
    kind,
    status: 'running',
    total,
    done: 0,
    failed: 0,
    startedAt: now,
    createdAt: now,
  }).returning({ id: tables.sizeChartJobs.id }).get()
  running = job.id

  const handle: JobHandle = {
    id: job.id,
    progress: (patch) => {
      const set: Partial<typeof tables.sizeChartJobs.$inferInsert> = {}
      if (patch.done !== undefined) set.done = patch.done
      if (patch.failed !== undefined) set.failed = patch.failed
      if (patch.total !== undefined) set.total = patch.total
      if (patch.note !== undefined) set.note = patch.note
      useDb().update(tables.sizeChartJobs).set(set).where(eq(tables.sizeChartJobs.id, job.id)).run()
    },
  }

  let crashed = false
  void work(handle)
    .then(() => {
      useDb().update(tables.sizeChartJobs).set({ status: 'done', note: null, finishedAt: nowColumnText() }).where(eq(tables.sizeChartJobs.id, job.id)).run()
    })
    .catch((error) => {
      crashed = true
      console.error(`[Size charts] ${kind} job crashed:`, error)
      useDb().update(tables.sizeChartJobs)
        .set({ status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: nowColumnText() })
        .where(eq(tables.sizeChartJobs.id, job.id))
        .run()
    })
    .finally(() => {
      running = null
      if (crashed || !then) return
      try {
        then()
      }
      catch (error) {
        console.error(`[Size charts] the follow-up after the ${kind} job could not start:`, error)
      }
    })

  return { jobId: job.id, started: true }
}

export interface IntakeInput {
  /** Handles the workbook named for each 1688 id, when it carried the products export. */
  handlesBySource?: ReadonlyMap<string, readonly string[]>
  /** Only these 1688 ids' pictures; absent means every queued picture the app has not fetched. */
  sourceIds?: readonly string[]
  /** Walk the whole catalogue even when every id already has a product (the "Sync products" button). */
  fullSync?: boolean
  /** Fetch pictures whose last attempt failed, too. */
  retryFailed?: boolean
  /** Start reading the fetched pictures as soon as the intake ends (when the reader has a key). */
  thenRead?: boolean
}

/** Tie sheet rows to products and fetch the pictures. Returns at once with the job id. */
export function startIntakeJob(client: GraphqlClient, input: IntakeInput = {}): StartJobResult {
  const toFetch = () => {
    const statuses = input.retryFailed ? (['queued', 'image-failed'] as const) : (['queued'] as const)
    return chartsWithStatus(statuses, input.sourceIds).filter(record => record.imageUrl && (!record.imagePath || record.status === 'image-failed'))
  }
  const planned = toFetch()

  return launchSizeChartJob('intake', planned.length, async (job) => {
    const startedAt = nowColumnText()

    const handles = [...(input.handlesBySource?.values() ?? [])].flat()
    if (handles.length > 0) {
      job.progress({ note: `Matching ${handles.length} ${handles.length === 1 ? 'product' : 'products'} by handle in Shopify…` })
      await syncProductsByHandle(client, handles)
    }

    const stillUnmatched = unmatchedSourceIds()
    const needScan = input.fullSync || stillUnmatched.length > 0
    if (needScan) {
      job.progress({ note: 'Reading the product list from Shopify…' })
      const result = await syncAllProductSources(client, {
        onPage: (seen, withSource) => job.progress({ note: `Reading the product list from Shopify… ${seen.toLocaleString()} products seen, ${withSource.toLocaleString()} with a 1688 id` }),
      })
      // Everything the walk did not see again has been deleted in Shopify.
      dropProductSourcesOlderThan(startedAt)
      job.progress({ note: `${result.withSource.toLocaleString()} of ${result.seen.toLocaleString()} products carry a 1688 id` })
    }

    const records = toFetch()
    job.progress({ total: records.length, note: records.length === 0 ? null : `Fetching ${records.length} ${records.length === 1 ? 'picture' : 'pictures'} from 1688…` })
    let done = 0
    let failed = 0
    const limit = pLimit(IMAGE_CONCURRENCY)
    await Promise.all(records.map(record => limit(async () => {
      try {
        const image = await fetchImage(record.imageUrl!)
        markImageFetched(record.id, image)
        if (record.status === 'image-failed') updateChart(record.id, { status: 'queued' })
      }
      catch (error) {
        failed++
        markFailed(record.id, 'image-failed', error instanceof Error ? error.message : String(error))
      }
      done++
      job.progress({ done, failed })
    })))
  }, input.thenRead ? () => void startReadJob() : undefined)
}

export interface ReadJobInput {
  /** Only these 1688 ids; absent means every fetched picture still queued. */
  sourceIds?: readonly string[]
  /** Read pictures whose last reading failed, too. */
  retryFailed?: boolean
}

export interface ReadJobDeps {
  /** The reader itself — a test passes a fake; the app reads with the key from the environment. */
  read?: (input: ReadInput) => Promise<ReadResult>
  config?: ReaderConfig | null
}

/**
 * Read every fetched picture into a chart. A picture two products share is
 * read once; the second gets the same transcript, normalised for its own
 * store (Chest or Bust). Returns at once with the job id — or, when the
 * reader has no key, with the reason nothing started.
 */
export function startReadJob(input: ReadJobInput = {}, deps: ReadJobDeps = {}): StartJobResult {
  const config = deps.config === undefined ? readerConfigFromEnv() : deps.config
  const read = deps.read ?? (config ? (readInput: ReadInput) => readSizeChartImage(readInput, config) : null)
  if (!read) {
    return { jobId: null, started: false, reason: 'The reading key is not set on the server (ANTHROPIC_API_KEY), so the pictures wait in the queue.' }
  }
  const statuses = input.retryFailed ? (['queued', 'read-failed'] as const) : (['queued'] as const)
  const records = chartsWithStatus(statuses, input.sourceIds).filter(record => record.imagePath && record.imageSha256)
  if (records.length === 0) {
    return { jobId: null, started: false, reason: 'No fetched pictures are waiting to be read.' }
  }
  const autoApproveAllowed = getBooleanSetting(SETTING_SIZE_CHARTS_AUTO_APPROVE, false)
  const model = config?.model ?? 'reader'

  return launchSizeChartJob('read', records.length, async (job) => {
    job.progress({ note: `Reading ${records.length} ${records.length === 1 ? 'picture' : 'pictures'}…` })
    const products = productsForSources(records.map(record => record.sourceProductId))
    let done = 0
    let failed = 0

    // Rows showing the same picture go through together, in order, so the
    // picture is read once and the rest copy it — two of them read side by
    // side would each have asked the reader before either had an answer.
    const groups = new Map<string, typeof records>()
    for (const record of records) {
      const list = groups.get(record.imageSha256!) ?? []
      list.push(record)
      groups.set(record.imageSha256!, list)
    }

    const limit = pLimit(READ_CONCURRENCY)
    await Promise.all([...groups.values()].map(group => limit(async () => {
      const first = group[0]!
      const twin = readForImage(first.imageSha256!, first.id)
      const twinRead = twin ? parseRead(twin.readJson) : null
      let shared: ReadResult | null = twinRead ? { read: twinRead, model: twin!.readModel ?? model, tokensIn: 0, tokensOut: 0 } : null
      let refusal: string | null = null

      for (const record of group) {
        try {
          if (refusal) throw new Error(refusal)
          let result: ReadResult
          if (shared) {
            result = { read: shared.read, model: shared.model, tokensIn: 0, tokensOut: 0 }
          }
          else {
            const image = readFileSync(record.imagePath!)
            const kind = imageKindOf(image)
            if (!kind) throw new Error('the kept picture is not readable any more')
            const product = products.get(record.sourceProductId)?.[0]
            result = await read({ image, mediaType: mediaTypeOf(kind), productTitle: product?.title ?? null, productType: record.productType, store: record.store })
            shared = result
          }
          const { chart, assessment } = normaliseChart(result.read, {
            store: record.store,
            sizesSold: sizesSoldOf(products.get(record.sourceProductId)?.[0]),
          })
          markRead(record.id, {
            read: result.read,
            chart,
            flags: assessment.flags,
            notices: assessment.notices,
            confidence: assessment.confidence,
            autoApprove: assessment.autoApprove && autoApproveAllowed,
            model: result.model,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
          })
        }
        catch (error) {
          failed++
          refusal = error instanceof Error ? error.message : String(error)
          markFailed(record.id, 'read-failed', refusal)
        }
        done++
        job.progress({ done, failed })
      }
    })))
  })
}

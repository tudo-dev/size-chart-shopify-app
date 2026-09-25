/**
 * Work the app promised and must not forget, picked up by itself.
 *
 * The line of waiting jobs lives in memory, so a restart (a deploy, a crash)
 * empties it. What matters survives anyway, because it is written on the
 * charts: a take-off a person asked for (`withdrawRequestedAt`) and a chart a
 * person approved (`approved`). At start-up both are started again. Once a
 * day every chart still on the website is checked against Shopify too, so a
 * product whose 1688 id was changed by hand, or that was deleted, loses the
 * chart within a day even if nobody presses Sync products.
 *
 * Only the store ALLOWED_SHOPS names, installed and not removed: the size
 * chart tables belong to that one store.
 */

import type { GraphqlClient } from '@shopify/shopify-api'
import { isNull } from 'drizzle-orm'
import * as tables from '../db/schema'
import { useDb } from './db'
import { columnText, fromColumnText } from './time'
import { shopAllowed } from './allowed-shops'
import { getSetting, setSetting, SETTING_SIZE_CHARTS_LAST_RECHECK } from './app-settings'
import { chartsWithdrawRequested, chartsWithStatus, updateChart } from './size-chart-store'
import { chartsToPublish } from './size-chart-publish'
import type { GraphqlRequester } from './size-chart-publish'
import { recordSendFailure, startIntakeJob, startPublishJob, startWithdrawJob, whenIdle } from './size-chart-jobs'

const RECHECK_EVERY_MS = 24 * 60 * 60 * 1000

/** A full check of the website is due: never done, or last queued a day or more ago. */
export function recheckDue(nowMs = Date.now()): boolean {
  const last = fromColumnText(getSetting(SETTING_SIZE_CHARTS_LAST_RECHECK))
  return !last || nowMs - last.getTime() >= RECHECK_EVERY_MS
}

export interface ResumeDeps {
  /** How to reach a store with no page open; the app uses clientForShop. */
  clientFor: (shop: string) => Promise<GraphqlRequester>
  allowedShops?: string
  isDev?: boolean
}

/** The one store the tables belong to, or null. */
export function storeToResume(deps: Pick<ResumeDeps, 'allowedShops' | 'isDev'>): string | null {
  const installed = useDb().select({ shop: tables.shops.shop }).from(tables.shops).where(isNull(tables.shops.uninstalledAt)).all()
    .map(row => row.shop)
    .filter(shop => shopAllowed(shop, deps.allowedShops, deps.isDev ?? false))
  if (installed.length !== 1) return null
  return installed[0]!
}

/**
 * Queue what is owed: every unfinished take-off; at start-up, the pictures
 * still to fetch (free, no catalogue walk); then a send of the approved
 * charts, and, when `recheck`, a fresh look at every chart still live.
 * Returns what it queued, for the log.
 */
export function resumeSizeChartWork(deps: ResumeDeps, options: { recheck?: boolean, fetchPictures?: boolean, nowMs?: number } = {}): { shop: string | null, withdraws: number, pictures: number, publish: boolean } {
  const shop = storeToResume(deps)
  if (!shop) return { shop: null, withdraws: 0, pictures: 0, publish: false }
  const withdraws = chartsWithdrawRequested()
  for (const record of withdraws) {
    whenIdle(async () => startWithdrawJob(await deps.clientFor(shop), record.id), (error) => {
      updateChart(record.id, { error: `It could not be taken off the website: ${error instanceof Error ? error.message : String(error)}. Press Take off the website again.`.slice(0, 1000) })
    })
  }
  const pictures = options.fetchPictures ? chartsWithStatus(['queued']).filter(record => record.imageUrl && !record.imagePath).length : 0
  if (pictures > 0) whenIdle(async () => startIntakeJob(await deps.clientFor(shop) as unknown as GraphqlClient, { skipScan: true }))
  const recheck = options.recheck === true
  if (recheck) {
    // The daily check: approved, failed and live charts all get a fresh look.
    const publish = chartsToPublish({ includePublished: true }).length > 0
    if (publish) whenIdle(async () => startPublishJob(await deps.clientFor(shop), { includePublished: true }), error => recordSendFailure(undefined, error))
    setSetting(SETTING_SIZE_CHARTS_LAST_RECHECK, columnText(options.nowMs ?? Date.now()))
    return { shop, withdraws: withdraws.length, pictures, publish }
  }
  // Otherwise only what a person approved and is still waiting: a chart that
  // failed waits for the daily check or a press, so it does not jump to the
  // top of the list every hour.
  const approved = chartsToPublish().filter(record => record.status === 'approved').map(record => record.id)
  const publish = approved.length > 0
  if (publish) whenIdle(async () => startPublishJob(await deps.clientFor(shop), { chartIds: approved }), error => recordSendFailure(approved, error))
  return { shop, withdraws: withdraws.length, pictures, publish }
}

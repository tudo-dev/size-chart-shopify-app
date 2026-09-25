/**
 * Operator switches, read at run time from the `app_setting` table.
 *
 * One row per key. Values are strings; the helpers here give each switch a
 * type and a default, so a missing row means "the default", never a crash.
 */

import { eq } from 'drizzle-orm'
import * as tables from '../db/schema'
import { useDb } from './db'
import { nowColumnText } from './time'

/**
 * Let the app approve a size chart by itself when nothing at all stood out
 * in the reading. Off until a person has watched enough charts to trust it;
 * a chart with even one flag always waits for a person, switch or no switch.
 */
export const SETTING_SIZE_CHARTS_AUTO_APPROVE = 'sizeCharts.autoApprove'

/**
 * Read the pictures by itself as soon as an uploaded sheet's pictures are
 * fetched. Off until a person has watched enough readings: every reading
 * costs money, and the first day showed a surprise run of 84.
 */
export const SETTING_SIZE_CHARTS_AUTO_READ = 'sizeCharts.autoRead'

/**
 * When the last full check of every chart on the website was queued, as a
 * column time. Kept here, not in memory, so a restart does not reset the
 * daily clock (an app deployed every day would otherwise never check).
 */
export const SETTING_SIZE_CHARTS_LAST_RECHECK = 'sizeCharts.lastRecheckAt'

/**
 * A switch's value, or null when it has never been set.
 *
 * Never throws. A missing ROW has always meant "the default"; a settings table
 * that will not answer — an old copy of the database, a half-finished
 * migration — means the same thing, because the callers are the pages and the
 * background jobs, and none may be brought down by a switch nobody has flipped.
 */
export function getSetting(key: string): string | null {
  try {
    return useDb().select({ value: tables.appSettings.value }).from(tables.appSettings).where(eq(tables.appSettings.key, key)).get()?.value ?? null
  }
  catch (error) {
    console.warn(`[Settings] could not read ${key}:`, error)
    return null
  }
}

export function setSetting(key: string, value: string): void {
  const now = nowColumnText()
  useDb().insert(tables.appSettings).values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: tables.appSettings.key, set: { value, updatedAt: now } })
    .run()
}

export function getBooleanSetting(key: string, fallback = false): boolean {
  const value = getSetting(key)
  if (value === null) return fallback
  return value === 'true'
}

export function setBooleanSetting(key: string, value: boolean): void {
  setSetting(key, value ? 'true' : 'false')
}

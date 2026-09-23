import type { GraphqlClient, Session } from '@shopify/shopify-api'
import { eq } from 'drizzle-orm'
import * as tables from '../db/schema'
import { useDb } from './db'
import { API_VERSION, useShopifyApi } from './shopify'
import { columnText, fromColumnText } from './time'

/**
 * The store's access token, kept for work that runs with no page open.
 *
 * Shopify may issue an offline token that expires, with a refresh token beside
 * it. Everything that comes back is saved, and a background job renews the
 * token before it runs out, instead of failing an hour into a batch.
 */

/** Renew this long before expiry, so a job never starts with a token about to die. */
export const RENEW_BEFORE_MS = 5 * 60 * 1000

export function saveShopSession(session: Pick<Session, 'shop' | 'accessToken' | 'scope' | 'expires' | 'refreshToken' | 'refreshTokenExpires'>): void {
  if (!session.accessToken) throw new Error(`Shopify returned no access token for ${session.shop}`)
  const now = columnText()
  const values = {
    accessToken: session.accessToken,
    scope: session.scope ?? null,
    expiresAt: session.expires ? columnText(session.expires) : null,
    refreshToken: session.refreshToken ?? null,
    refreshTokenExpiresAt: session.refreshTokenExpires ? columnText(session.refreshTokenExpires) : null,
    updatedAt: now,
    uninstalledAt: null,
  }
  useDb().insert(tables.shops)
    .values({ shop: session.shop, installedAt: now, ...values })
    .onConflictDoUpdate({ target: tables.shops.shop, set: values })
    .run()
}

/** What a background job should do with the token on file. Pure, so it can be tested. */
export type TokenPlan = 'use' | 'renew' | 'reopen-app' | 'not-installed'
export function planToken(row: Pick<tables.ShopRow, 'expiresAt' | 'refreshToken' | 'refreshTokenExpiresAt' | 'uninstalledAt'> | undefined, nowMs: number): TokenPlan {
  if (!row || row.uninstalledAt) return 'not-installed'
  const expires = fromColumnText(row.expiresAt)
  if (!expires || expires.getTime() - nowMs > RENEW_BEFORE_MS) return 'use'
  const refreshExpires = fromColumnText(row.refreshTokenExpiresAt)
  const refreshUsable = row.refreshToken && (!refreshExpires || refreshExpires.getTime() > nowMs)
  return refreshUsable ? 'renew' : 'reopen-app'
}

/** A GraphQL client for a shop with no admin request in hand — for background jobs. */
export async function clientForShop(shop: string, nowMs = Date.now()): Promise<GraphqlClient> {
  const db = useDb()
  const row = db.select().from(tables.shops).where(eq(tables.shops.shop, shop)).get()
  const plan = planToken(row, nowMs)
  if (plan === 'not-installed') throw new Error(`The app is not installed on ${shop}.`)
  if (plan === 'reopen-app') throw new Error(`The app's access to ${shop} has run out. Open Tudoholic Size Charts in Shopify admin once to renew it.`)

  const shopify = useShopifyApi()
  let accessToken = row!.accessToken
  if (plan === 'renew') {
    const { session } = await shopify.auth.refreshToken({ shop, refreshToken: row!.refreshToken! })
    saveShopSession(session)
    accessToken = session.accessToken || ''
  }
  return new shopify.clients.Graphql({ session: { shop, accessToken } as Session, apiVersion: API_VERSION })
}

/** Shopify says the app was removed: the token is dead, so nothing may use it. */
export function markUninstalled(shop: string): void {
  useDb().update(tables.shops).set({ uninstalledAt: columnText(), updatedAt: columnText() })
    .where(eq(tables.shops.shop, shop)).run()
}

/** Shopify's shop/redact, 48 hours after removal: this store's data goes. */
export function forgetShop(shop: string): void {
  useDb().delete(tables.shops).where(eq(tables.shops.shop, shop)).run()
}

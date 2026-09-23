import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * One row per Shopify store the app is installed on.
 *
 * Built for more than one store from day one: the boss has said India
 * operations start next month, and whether that is a second Shopify store is
 * not yet known. Every later table keys on `shop`, so a second store is an
 * install, not a redesign.
 *
 * The access token is what background jobs (reading pictures, publishing
 * charts) use when no one has the page open. Shopify may hand out a token that
 * expires, with a refresh token beside it; both are kept so the job renews it
 * instead of stopping after an hour.
 */
export const shops = sqliteTable('shop', {
  shop: text('shop').primaryKey(),
  accessToken: text('access_token').notNull(),
  scope: text('scope'),
  /** When the access token stops working, column text `YYYY-MM-DD HH:MM:SS`; null = it does not expire. */
  expiresAt: text('expires_at'),
  refreshToken: text('refresh_token'),
  refreshTokenExpiresAt: text('refresh_token_expires_at'),
  installedAt: text('installed_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  /** Set when Shopify says the app was removed; the row stays so a reinstall keeps its history. */
  uninstalledAt: text('uninstalled_at'),
}, table => ({
  byUninstalled: index('shop_uninstalled_idx').on(table.uninstalledAt),
}))

/** Operator switches, one row per key. A missing row means the default, never a crash. */
export const appSettings = sqliteTable('app_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export type ShopRow = typeof shops.$inferSelect

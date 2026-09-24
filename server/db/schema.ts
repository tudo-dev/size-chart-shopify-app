import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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

/* ---- Size charts: moved unchanged from Tudoholic Logistics (migrations 0022-0024 there). ---- */

/**
 * One size chart per 1688 product, from the listing team's sheet to the
 * storefront. `status` walks: `no-image` (the sheet has no picture link) →
 * `queued` (picture to fetch and read) → `needs-review` / `approved` (a
 * person's decision, or the app's when nothing stood out) → `published`
 * (in Shopify). `image-failed`, `read-failed` and `publish-failed` keep the
 * error; `skipped` is a person saying "not this one".
 */
export const sizeCharts = sqliteTable('size_chart', {
  id: integer('id').primaryKey(),
  /** The 1688 offer id — the key the sheet, the products and the pictures share. */
  sourceProductId: text('source_product_id').notNull(),
  sourceUrl: text('source_url'),
  productType: text('product_type'),
  /** MENS or WOMENS, from the sheet — decides Chest vs Bust. */
  store: text('store'),
  remark: text('remark'),
  imageUrl: text('image_url'),
  imageSha256: text('image_sha256'),
  imagePath: text('image_path'),
  imageBytes: integer('image_bytes'),
  imageWidth: integer('image_width'),
  imageHeight: integer('image_height'),
  imageFetchedAt: text('image_fetched_at'),
  status: text('status').notNull(),
  /** The reader's transcript, JSON (`ReadChart`). */
  readJson: text('read_json'),
  /** The finished chart, JSON (`PublishedChart`) — what Shopify gets. */
  chartJson: text('chart_json'),
  /** JSON string[] of plain reasons a person should look. */
  flags: text('flags'),
  /** JSON string[] of what the app changed on purpose (a re-pivoted size column). Not doubts. */
  notices: text('notices'),
  confidence: real('confidence'),
  readModel: text('read_model'),
  readAt: text('read_at'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  reviewNote: text('review_note'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: text('reviewed_at'),
  shopifyFileId: text('shopify_file_id'),
  shopifyImageUrl: text('shopify_image_url'),
  publishedAt: text('published_at'),
  /** sha256 of `chartJson` as published, so an unchanged chart is never sent twice. */
  publishedSha256: text('published_sha256'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => ({
  source: uniqueIndex('idx_size_chart_source').on(table.sourceProductId),
  status: index('idx_size_chart_status').on(table.status),
  image: index('idx_size_chart_image').on(table.imageSha256),
}))

/**
 * The shop's products that carry a 1688 id, copied from Shopify by the
 * product sync so a sheet row can be tied to its product(s) without asking
 * Shopify for every row. Several products may share one 1688 id (a re-listed
 * item); each gets the chart.
 */
export const shopifyProductSources = sqliteTable('shopify_product_source', {
  shopifyProductId: text('shopify_product_id').primaryKey(),
  handle: text('handle').notNull(),
  title: text('title').notNull(),
  productType: text('product_type'),
  status: text('status'),
  sourceProductId: text('source_product_id').notNull(),
  sourceUrl: text('source_url'),
  /** JSON string[]: the values of the product's Size option, as the shop sells them ("S", "M", "38"). Null when the product has no size option. */
  sizeOptions: text('size_options'),
  syncedAt: text('synced_at').notNull(),
}, table => ({
  source: index('idx_product_source_id').on(table.sourceProductId),
}))

/** A size-chart job (`intake`, `read`, `publish`) with progress the page can poll; persisted so a restart mid-run is visible. */
export const sizeChartJobs = sqliteTable('size_chart_job', {
  id: integer('id').primaryKey(),
  kind: text('kind').notNull(),
  /** `running`, `done`, `failed`. */
  status: text('status').notNull(),
  total: integer('total').notNull().default(0),
  done: integer('done').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  /** A short sentence about the step under way, for the page. */
  note: text('note'),
  error: text('error'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  createdAt: text('created_at').notNull(),
})

/** Every sheet uploaded, for the audit trail: what it held and what changed. */
export const sizeChartUploads = sqliteTable('size_chart_upload', {
  id: integer('id').primaryKey(),
  fileName: text('file_name').notNull(),
  fileSha256: text('file_sha256').notNull(),
  uploadedBy: text('uploaded_by'),
  rows: integer('rows').notNull(),
  added: integer('added').notNull(),
  changed: integer('changed').notNull(),
  unchanged: integer('unchanged').notNull(),
  noImage: integer('no_image').notNull(),
  skipped: integer('skipped').notNull(),
  createdAt: text('created_at').notNull(),
})

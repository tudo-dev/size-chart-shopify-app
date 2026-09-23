/**
 * Everything the app may touch in the store, and nothing more.
 *
 * Products: read each product's sizes and 1688 link, and save the finished
 * chart on the product. Files: store the chart picture in Shopify. No orders,
 * no customers — this app has no business with either.
 *
 * All four are asked for NOW, in the first install, so that adding the
 * publishing step later does not need the store owner to approve the app a
 * second time. shopify.app.toml must say exactly the same; the verify suite
 * checks that the two lists agree.
 */
/**
 * The app's Shopify key and secret, read from the server's environment at the
 * moment they are needed.
 *
 * NOT through Nuxt's runtimeConfig: that is filled when the app is BUILT, and
 * the build never sees .env (it is kept out of the Docker image on purpose, so
 * the secret is never baked into it). Read that way, both came back empty in
 * the real container on 2026-09-23 — every genuine Shopify webhook was refused
 * and the login could not have worked. The verify suite pins this.
 */
export function shopifyCredentials(): { apiKey: string, apiSecretKey: string } {
  return {
    apiKey: process.env.SHOPIFY_API_KEY || '',
    apiSecretKey: process.env.SHOPIFY_API_SECRET || '',
  }
}

export const APP_SCOPES = ['read_products', 'write_products', 'read_files', 'write_files'] as const

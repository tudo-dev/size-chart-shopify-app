import { createResolver } from '@nuxt/kit'

const { resolve } = createResolver(import.meta.url)

/**
 * Tudoholic Size Charts — an embedded Shopify admin app.
 *
 * Built the same way as Tudoholic Logistics on purpose (Nuxt, Polaris, SQLite,
 * Docker), so the team runs one kind of app, not two. It lives apart from
 * Logistics so a size-chart job or bug can never slow down or break order
 * booking, and so it asks Shopify only for what it needs: products and files.
 */
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', 'nuxt-security'],

  // The admin page is an app inside Shopify's iframe; nothing is rendered on
  // the server, and the customer-facing website never talks to this server.
  ssr: false,
  devtools: { enabled: false },

  vue: {
    compilerOptions: {
      // App Bridge's <ui-*> elements are native custom elements from the CDN
      // script (server/plugins/app-bridge.ts), not Vue components.
      isCustomElement: tag => tag.startsWith('ui-'),
    },
  },

  // Only build-safe values here. The Shopify key and secret are read from the
  // server's environment when used (server/utils/scopes.ts): anything put in
  // runtimeConfig is fixed at BUILD time, and the build never sees .env.
  runtimeConfig: {
    dbDir: resolve('./server/db'),
  },

  build: {
    transpile: ['@ownego/polaris-vue'],
  },
  future: {
    compatibilityVersion: 4,
  },
  compatibilityDate: '2025-05-15',

  nitro: {
    // The Shopify library needs its Node adapter loaded before first use
    // (`import '@shopify/shopify-api/adapters/node'` in server/utils/shopify.ts).
    // Nitro drops every import that binds nothing unless it is listed here, so
    // without this the build had NO adapter and every login failed with
    // "Missing adapter implementation" (found on 2026-09-24, in `shopify app
    // dev`). server/plugins/shopify-adapter.ts loads it at start-up as well,
    // the way Tudoholic Logistics has done since 2025.
    moduleSideEffects: ['@shopify/shopify-api/adapters/node'],
  },

  vite: {
    server: {
      // `shopify app dev` serves a laptop through a trycloudflare.com tunnel,
      // and Vite's dev server refuses any host it was not told about
      // ("Blocked request. This host … is not allowed", 2026-09-24). Only the
      // laptop's dev server reads this; the built app has no Vite server.
      allowedHosts: ['.trycloudflare.com'],
    },
  },

  eslint: {
    config: {
      stylistic: true,
    },
  },

  security: {
    // Shopify's admin frames the app; everything else may not.
    headers: {
      contentSecurityPolicy: {
        'frame-ancestors': ['https://admin.shopify.com', 'https://*.myshopify.com'],
        'img-src': ['\'self\'', 'data:', 'blob:', 'https://cdn.shopify.com'],
        'font-src': ['\'self\'', 'https:', 'data:'],
        'style-src': ['\'self\'', 'https:', '\'unsafe-inline\''],
        'script-src': ['\'self\'', 'https://cdn.shopify.com', '\'unsafe-inline\''],
        'connect-src': ['\'self\'', 'https:'],
      },
      crossOriginEmbedderPolicy: false,
    },
    // Off: nuxt-security's default allows 150 requests per 5 minutes per
    // address for the whole app, and the review page's own progress polling
    // used that up about 3 minutes into a picture-reading job — then every
    // page and webhook from that address got 429 (reproduced 2026-09-24).
    // Every /api route already needs a verified Shopify login.
    rateLimiter: false,
    // Off: it refused any review note or search with < or > ("M -> L",
    // "length < 70") with a bare 400. Vue escapes everything it shows and the
    // server renders no HTML.
    xssValidator: false,
    // Shopify posts webhooks with bodies the default size limit might refuse.
    requestSizeLimiter: {
      maxRequestSizeInBytes: 2_000_000,
      maxUploadFileRequestInBytes: 20_000_000,
    },
  },
})

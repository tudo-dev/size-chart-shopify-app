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
    // Shopify posts webhooks with bodies the default size limit might refuse.
    requestSizeLimiter: {
      maxRequestSizeInBytes: 2_000_000,
      maxUploadFileRequestInBytes: 20_000_000,
    },
  },
})

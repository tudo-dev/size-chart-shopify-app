import { getRequestHeader, readRawBody } from 'h3'

/** Shopify: the app was removed from a store. Its token is dead from now on. */
export default defineEventHandler(async (event) => {
  const raw = await readRawBody(event) ?? ''
  if (!isShopifySignature(raw, getRequestHeader(event, 'x-shopify-hmac-sha256'), shopifyCredentials().apiSecretKey)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid signature' })
  }
  const shop = getRequestHeader(event, 'x-shopify-shop-domain')
  if (shop) {
    markUninstalled(shop)
    forgetCachedToken(shop)
  }
  return { ok: true }
})

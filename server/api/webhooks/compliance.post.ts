import { getRequestHeader, readRawBody } from 'h3'

/**
 * The three privacy webhooks every Shopify app must answer.
 *
 *   customers/data_request, customers/redact — this app keeps no customer
 *     data at all (products and pictures only), so there is nothing to send or
 *     erase; the request is acknowledged.
 *   shop/redact — 48 hours after a store removes the app: that store's data
 *     is deleted.
 *
 * A request without a valid signature is refused with 401, as Shopify requires.
 */
export default defineEventHandler(async (event) => {
  const raw = await readRawBody(event) ?? ''
  if (!isShopifySignature(raw, getRequestHeader(event, 'x-shopify-hmac-sha256'), shopifyCredentials().apiSecretKey)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid signature' })
  }
  const topic = getRequestHeader(event, 'x-shopify-topic')
  const shop = getRequestHeader(event, 'x-shopify-shop-domain')
  if (topic === 'shop/redact' && shop) forgetShop(shop)
  return { ok: true }
})

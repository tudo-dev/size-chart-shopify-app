import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Whether a webhook body really came from Shopify: its HMAC, keyed with the
 * app secret, must match the header. Pure, so it is tested without a server.
 */
export function isShopifySignature(rawBody: string | Buffer, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader || !secret) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64')
  const a = Buffer.from(expected)
  const b = Buffer.from(hmacHeader)
  // timingSafeEqual throws on unequal lengths; a wrong length is simply wrong.
  return a.length === b.length && timingSafeEqual(a, b)
}

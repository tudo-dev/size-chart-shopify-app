import '@shopify/shopify-api/adapters/node'

import type { GraphqlClient, Session } from '@shopify/shopify-api'
import { ApiVersion, RequestedTokenType, shopifyApi } from '@shopify/shopify-api'
import type { H3Event } from 'h3'
import { getRequestHeaders } from 'h3'
import { APP_SCOPES, shopifyCredentials } from './scopes'
import { createAccessTokenCache, retryOnceOnUnauthorized } from './shopify-auth'
import { saveShopSession } from './shop-tokens'

/**
 * The Shopify login, taken from Tudoholic Logistics where it has run in
 * production since August: the admin page's session token is checked on every
 * request, and exchanged ONCE per shop for an offline access token that is
 * then kept. What is new here is that the token is also saved in this app's
 * own database, so background jobs can reach the store with no page open.
 */

export const API_VERSION = ApiVersion.July26

/** Where this app lives; `shopify app dev` sets SHOPIFY_APP_URL, and so does the server's .env. */
export function appHost(): string {
  const url = process.env.SHOPIFY_APP_URL || 'https://sizecharts.tudoholic.com'
  return new URL(url).host
}

let _api: ReturnType<typeof createApi> | null = null
function createApi() {
  const { apiKey, apiSecretKey } = shopifyCredentials()
  if (!apiKey || !apiSecretKey) throw new Error('SHOPIFY_API_KEY and SHOPIFY_API_SECRET must be set in the server\'s .env')
  return shopifyApi({
    apiKey,
    apiSecretKey,
    scopes: [...APP_SCOPES],
    hostName: appHost(),
    apiVersion: API_VERSION,
    isEmbeddedApp: true,
  })
}
export function useShopifyApi() {
  _api ??= createApi()
  return _api
}

export function getSessionTokenFromHeaders(event: H3Event): string | undefined {
  return getRequestHeaders(event).authorization?.replace('Bearer ', '')
}

/**
 * Which shop this request speaks for, from a signature-checked session token.
 * Never read the token's payload without verifying it: a forged `dest` would
 * reach across shops.
 */
export async function verifiedShop(sessionToken: string): Promise<string> {
  const shopify = useShopifyApi()
  const payload = await shopify.session.decodeSessionToken(sessionToken)
  const shop = shopify.utils.sanitizeShop(new URL(payload.dest).hostname, true)
  if (!shop) throw new Error('Shop not found in session token')
  return shop
}

const accessTokens = createAccessTokenCache()

/** Forget a shop's cached token, so the next request exchanges a new one. */
export function forgetCachedToken(shop: string): void {
  accessTokens.invalidate(shop)
}

function accessTokenFor(shop: string, sessionToken: string): Promise<string> {
  return accessTokens.get(shop, async () => {
    const { session } = await useShopifyApi().auth.tokenExchange({
      sessionToken,
      shop,
      requestedTokenType: RequestedTokenType.OfflineAccessToken,
    })
    // Kept for background jobs. A failure to save must not deny the page its
    // answer — the token itself is good — so it is reported, not thrown.
    try {
      saveShopSession(session)
    }
    catch (error) {
      console.error(`[Shopify] could not save the access token for ${shop}:`, error)
    }
    return session.accessToken || ''
  })
}

/** The shop a request speaks for, or null — for callers where it is optional. */
export async function getVerifiedShop(event: H3Event): Promise<string | null> {
  const sessionToken = getSessionTokenFromHeaders(event)
  if (!sessionToken) return null
  try {
    return await verifiedShop(sessionToken)
  }
  catch {
    return null
  }
}

/**
 * A GraphQL client for the shop behind this admin request. Survives its cached
 * token being revoked underneath it (reinstall, scope change) by exchanging a
 * fresh one exactly once.
 */
export async function getClient(event: H3Event): Promise<{ client: GraphqlClient, shop: string }> {
  const sessionToken = getSessionTokenFromHeaders(event)
  if (!sessionToken) throw createError({ statusCode: 401, statusMessage: 'Open the app from Shopify admin.' })
  // A token that fails the signature check is a refusal, not a server fault:
  // 401, never 500, and never the reason (it would coach a forger).
  let shop: string
  try {
    shop = await verifiedShop(sessionToken)
  }
  catch {
    throw createError({ statusCode: 401, statusMessage: 'Your Shopify session could not be verified. Reload the app.' })
  }
  const shopify = useShopifyApi()

  const build = async () => new shopify.clients.Graphql({
    session: { accessToken: await accessTokenFor(shop, sessionToken), shop } as Session,
    apiVersion: API_VERSION,
  })

  type Send = (...args: Parameters<GraphqlClient['request']>) => Promise<unknown>
  const client = await build()
  const send = retryOnceOnUnauthorized<Parameters<GraphqlClient['request']>, unknown>(
    client.request.bind(client) as Send,
    async () => {
      forgetCachedToken(shop)
      const fresh = await build()
      return fresh.request.bind(fresh) as Send
    },
  )
  client.request = send as GraphqlClient['request']
  return { client, shop }
}

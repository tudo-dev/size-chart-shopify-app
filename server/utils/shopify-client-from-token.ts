import type { GraphqlClient, Session } from '@shopify/shopify-api'
import { API_VERSION, useShopifyApi } from './shopify'

/**
 * A GraphQL client from a shop and a token already in hand — what the size
 * chart routes give a background job (the name they had in Logistics). The
 * `host` argument is accepted and ignored: the app's host is fixed.
 */
export function createShopifyClientFromToken(shopUrl: string, accessToken: string, _host?: string): GraphqlClient {
  return new (useShopifyApi().clients.Graphql)({
    session: { accessToken, shop: shopUrl } as Session,
    apiVersion: API_VERSION,
  })
}

/**
 * The parts of Shopify authentication that can be wrong on their own.
 *
 * These live apart from `shopify.ts` because every request in the app passes
 * through them, and none of them can be exercised from a real Shopify session
 * in a test. Kept as plain functions over plain values, they can be.
 *
 * The behaviour they exist for, from 2026-08-17: `getClient` used to mint a
 * fresh offline access token from Shopify on every single request. Offline
 * tokens do not expire, so that round trip bought nothing — and it cost
 * something real. `shopify-api` accepts a session token for 10 seconds past its
 * expiry (JWT_PERMITTED_CLOCK_TOLERANCE); Shopify's token-exchange endpoint
 * does not. A request landing in that window was refused with a bare
 * `400 Bad Request`, which reached the merchant as raw text.
 */

/**
 * True only for Shopify refusing the credential itself.
 *
 * Narrow on purpose. A 401 is the one failure that says the operation did not
 * run, which is what makes retrying it safe; anything else may have committed
 * and must not be replayed.
 */
export function isUnauthorized(error: unknown): boolean {
  const code = (error as { response?: { code?: unknown } } | null)?.response?.code
  return code === 401
}

/**
 * Somewhere to keep one long-lived access token per shop.
 *
 * Holds the in-flight promise rather than the resolved token, so that several
 * requests arriving for a cold shop share a single exchange instead of racing
 * to perform the same one.
 */
export interface AccessTokenCache {
  /** The shop's token, exchanging one only if none is held. */
  get: (shop: string, exchange: () => Promise<string>) => Promise<string>
  /** Forget a shop's token, so the next `get` exchanges again. */
  invalidate: (shop: string) => void
  /** How many shops are held. For tests and diagnostics. */
  size: () => number
}

export function createAccessTokenCache(): AccessTokenCache {
  const tokens = new Map<string, Promise<string>>()

  return {
    get(shop, exchange) {
      const held = tokens.get(shop)
      if (held) return held

      const pending = exchange().then((token) => {
        if (!token) throw new Error('Shopify returned no access token for this shop')
        return token
      })

      // A failure must never be remembered as the answer, or one bad moment
      // would deny the shop until the process restarts. Only this attempt is
      // dropped, so a later successful exchange racing beside it is untouched.
      pending.catch(() => {
        if (tokens.get(shop) === pending) tokens.delete(shop)
      })

      tokens.set(shop, pending)
      return pending
    },

    invalidate(shop) {
      tokens.delete(shop)
    },

    size() {
      return tokens.size
    },
  }
}

/**
 * Wrap a call so a rejected credential is refreshed and the call retried once.
 *
 * Retrying is safe here in a way it is not for most failures: a 401 means
 * Shopify rejected the credential and never ran the operation, so replaying it
 * cannot create a second fulfillment or a second parcel. A timeout or a 5xx is
 * left alone — whether those committed is genuinely unknown, and that ambiguity
 * belongs to the caller that knows what was being attempted.
 *
 * Exactly one retry. `refresh` returns the replacement call, and its result is
 * returned whatever happens, so a second 401 surfaces rather than looping.
 */
export function retryOnceOnUnauthorized<A extends unknown[], R>(
  send: (...args: A) => Promise<R>,
  refresh: () => Promise<(...args: A) => Promise<R>>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await send(...args)
    }
    catch (error) {
      if (!isUnauthorized(error)) throw error
      const retry = await refresh()
      return await retry(...args)
    }
  }
}

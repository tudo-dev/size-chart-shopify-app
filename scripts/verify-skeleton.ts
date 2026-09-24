/**
 * Checks for the parts of the app that can be wrong on their own, run without
 * Shopify or a browser:  pnpm verify
 */
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failures++
    console.log('      expected:', JSON.stringify(expected))
    console.log('      actual  :', JSON.stringify(actual))
  }
}
const section = (title: string) => console.log(`\n${title}`)
const repo = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(join(repo, path), 'utf8')

// A throwaway database, migrated exactly as the container migrates it.
const scratch = mkdtempSync(join(tmpdir(), 'sizecharts-verify-'))
const dbFile = join(scratch, 'db.sqlite')
migrate(drizzle(new Database(dbFile)), { migrationsFolder: join(repo, 'server/db/migrations') })
process.env.DATABASE_URL = dbFile

const { isShopifySignature } = await import('../server/utils/webhook-verification')
const { planToken, saveShopSession, markUninstalled, forgetShop, RENEW_BEFORE_MS } = await import('../server/utils/shop-tokens')
const { createAccessTokenCache, retryOnceOnUnauthorized } = await import('../server/utils/shopify-auth')
const { columnText, fromColumnText } = await import('../server/utils/time')
const { APP_SCOPES } = await import('../server/utils/scopes')

// ---------------------------------------------------------------------------
section('A webhook is believed only with Shopify\'s signature')

const secret = 'test-secret'
const body = '{"shop_domain":"tudoholic-com.myshopify.com"}'
const signed = createHmac('sha256', secret).update(body).digest('base64')
check('the right signature is accepted', isShopifySignature(body, signed, secret), true)
check('a signature for another body is refused', isShopifySignature(`${body} `, signed, secret), false)
check('a signature made with another secret is refused', isShopifySignature(body, createHmac('sha256', 'other').update(body).digest('base64'), secret), false)
check('no signature, or no secret on our side, is refused', [isShopifySignature(body, undefined, secret), isShopifySignature(body, signed, '')], [false, false])
check('a signature of the wrong length is refused, not a crash', isShopifySignature(body, 'short', secret), false)

// ---------------------------------------------------------------------------
section('A background job knows what to do with the saved token')

const NOW = Date.parse('2026-09-23T06:00:00Z')
const at = (ms: number) => columnText(NOW + ms)
const HOUR = 3_600_000
check('no row: the app is not installed', planToken(undefined, NOW), 'not-installed')
check('an uninstalled store is never used', planToken({ expiresAt: null, refreshToken: null, refreshTokenExpiresAt: null, uninstalledAt: at(-HOUR) }, NOW), 'not-installed')
check('a token that never expires is used', planToken({ expiresAt: null, refreshToken: null, refreshTokenExpiresAt: null, uninstalledAt: null }, NOW), 'use')
check('a token good for another hour is used', planToken({ expiresAt: at(HOUR), refreshToken: 'r', refreshTokenExpiresAt: null, uninstalledAt: null }, NOW), 'use')
check('a token about to run out is renewed BEFORE it does', planToken({ expiresAt: at(RENEW_BEFORE_MS - 1000), refreshToken: 'r', refreshTokenExpiresAt: at(30 * 24 * HOUR), uninstalledAt: null }, NOW), 'renew')
check('an expired token with a good refresh token is renewed', planToken({ expiresAt: at(-HOUR), refreshToken: 'r', refreshTokenExpiresAt: null, uninstalledAt: null }, NOW), 'renew')
check('an expired token and an expired refresh token: open the app once', planToken({ expiresAt: at(-HOUR), refreshToken: 'r', refreshTokenExpiresAt: at(-1), uninstalledAt: null }, NOW), 'reopen-app')
check('an expired token and no refresh token: open the app once', planToken({ expiresAt: at(-HOUR), refreshToken: null, refreshTokenExpiresAt: null, uninstalledAt: null }, NOW), 'reopen-app')

section('…and the token is saved, replaced and forgotten correctly')

const { useDb } = await import('../server/utils/db')
const tables = await import('../server/db/schema')
const rowFor = (shop: string) => useDb().select().from(tables.shops).all().find(row => row.shop === shop)
saveShopSession({ shop: 'a.myshopify.com', accessToken: 'tok-1', scope: APP_SCOPES.join(','), expires: undefined, refreshToken: undefined, refreshTokenExpires: undefined })
check('a first install is saved, with no expiry', [rowFor('a.myshopify.com')?.accessToken, rowFor('a.myshopify.com')?.expiresAt, rowFor('a.myshopify.com')?.uninstalledAt], ['tok-1', null, null])
const installedAt = rowFor('a.myshopify.com')?.installedAt
saveShopSession({ shop: 'a.myshopify.com', accessToken: 'tok-2', scope: null as unknown as string, expires: new Date(NOW + HOUR), refreshToken: 'ref', refreshTokenExpires: new Date(NOW + 90 * 24 * HOUR) })
check('a new token replaces the old one, keeping the install date', [rowFor('a.myshopify.com')?.accessToken, rowFor('a.myshopify.com')?.installedAt, rowFor('a.myshopify.com')?.refreshToken, rowFor('a.myshopify.com')?.expiresAt], ['tok-2', installedAt, 'ref', columnText(NOW + HOUR)])
markUninstalled('a.myshopify.com')
check('removal marks the store, and a job then refuses it', [rowFor('a.myshopify.com')?.uninstalledAt !== null, planToken(rowFor('a.myshopify.com'), NOW)], [true, 'not-installed'])
saveShopSession({ shop: 'a.myshopify.com', accessToken: 'tok-3', scope: '', expires: undefined, refreshToken: undefined, refreshTokenExpires: undefined })
check('reinstalling brings it back', [rowFor('a.myshopify.com')?.uninstalledAt, rowFor('a.myshopify.com')?.accessToken], [null, 'tok-3'])
saveShopSession({ shop: 'b.myshopify.com', accessToken: 'tok-b', scope: '', expires: undefined, refreshToken: undefined, refreshTokenExpires: undefined })
forgetShop('a.myshopify.com')
check('shop/redact deletes that store, and only that store', [rowFor('a.myshopify.com'), rowFor('b.myshopify.com')?.accessToken], [undefined, 'tok-b'])
let refused = ''
try {
  saveShopSession({ shop: 'c.myshopify.com', accessToken: '', scope: '', expires: undefined, refreshToken: undefined, refreshTokenExpires: undefined })
}
catch (error) {
  refused = (error as Error).message
}
check('an empty token is refused, never saved', [refused.includes('no access token'), rowFor('c.myshopify.com')], [true, undefined])

// ---------------------------------------------------------------------------
section('The login plumbing, as Logistics runs it')

const cache = createAccessTokenCache()
let exchanges = 0
const slowExchange = () => new Promise<string>(resolve => setTimeout(() => {
  exchanges++
  resolve('token')
}, 10))
await Promise.all([cache.get('s', slowExchange), cache.get('s', slowExchange), cache.get('s', slowExchange)])
check('three requests at once share ONE exchange', exchanges, 1)
let failedOnce = false
await cache.get('t', async () => {
  throw new Error('down')
}).catch(() => {
  failedOnce = true
})
check('a failed exchange is not remembered as the answer', [failedOnce, await cache.get('t', async () => 'recovered')], [true, 'recovered'])
cache.invalidate('s')
check('forgetting a shop makes the next request exchange again', [cache.size(), await cache.get('s', async () => 'fresh')], [1, 'fresh'])

let calls = 0
const unauthorized = Object.assign(new Error('401'), { response: { code: 401 } })
const retried = await retryOnceOnUnauthorized(async () => {
  calls++
  throw unauthorized
}, async () => async () => 'second try')()
check('a refused token is refreshed and the call retried once', [calls, retried], [1, 'second try'])
let other = ''
await retryOnceOnUnauthorized(async () => {
  throw new Error('timeout')
}, async () => async () => 'never')().catch((error: Error) => {
  other = error.message
})
check('anything else is never retried — it may have happened', other, 'timeout')

// ---------------------------------------------------------------------------
section('Times are written one way')

check('a moment round-trips', columnText(fromColumnText('2026-09-23 06:00:00')!), '2026-09-23 06:00:00')
check('nonsense is no moment', [fromColumnText('not a time'), fromColumnText(null), fromColumnText('')], [null, null, null])

// ---------------------------------------------------------------------------
section('The app asks for products and files, and nothing else')

check('exactly four permissions', [...APP_SCOPES], ['read_products', 'write_products', 'read_files', 'write_files'])
check('no orders, no customers', APP_SCOPES.some(scope => /order|customer/.test(scope)), false)
// Linked to Shopify on 2026-09-23 as "Tudoholic Size Charts" in the tudoholic
// organisation — the same one Tudoholic Logistics is in.
check('shopify.app.toml exists', existsSync(join(repo, 'shopify.app.toml')), true)
const toml = existsSync(join(repo, 'shopify.app.toml')) ? read('shopify.app.toml') : ''
const declared = /scopes\s*=\s*"([^"]*)"/.exec(toml)?.[1]?.split(',').map(scope => scope.trim()).filter(Boolean).sort()
check('shopify.app.toml asks for exactly the same', declared, [...APP_SCOPES].sort())
check('  and it is this app, not Tudoholic Logistics', [/client_id = "0f8e54d5b874a56aeda52d19d0a5006a"/.test(toml), /8e854da19c6e8be806613b57d639b4ed/.test(toml)], [true, false])
check('  its webhooks speak the same API version as the server code', /api_version = "2026-07"/.test(toml) && /ApiVersion\.July26/.test(read('server/utils/shopify.ts')), true)
check('  every webhook it names exists', ['/api/webhooks/app-uninstalled', '/api/webhooks/compliance'].map(path => toml.includes(`https://sizecharts.tudoholic.com${path}"`) && existsSync(join(repo, `server${path}.post.ts`))), [true, true])
check('  all three privacy topics are answered', /compliance_topics = \[ "customers\/data_request", "customers\/redact", "shop\/redact" \]/.test(toml), true)
check('  no secret is in it', /secret/i.test(toml.replace(/the secret is never in this file/, '')), false)

// ---------------------------------------------------------------------------
section('Where things are wired')

const compliance = read('server/api/webhooks/compliance.post.ts')
check('the privacy webhooks refuse an unsigned request with 401', /isShopifySignature\(/.test(compliance) && /statusCode: 401/.test(compliance), true)
check('  and shop/redact deletes that store', /topic === 'shop\/redact' && shop\) forgetShop\(shop\)/.test(compliance), true)
const uninstalled = read('server/api/webhooks/app-uninstalled.post.ts')
check('removal is believed only when signed, and drops the cached token too', /isShopifySignature\(/.test(uninstalled) && /markUninstalled\(shop\)/.test(uninstalled) && /forgetCachedToken\(shop\)/.test(uninstalled), true)
check('App Bridge is loaded on every page', /app-bridge\.js/.test(read('server/plugins/app-bridge.ts')), true)

// 2026-09-23, in the real container: the secret came through Nuxt's
// runtimeConfig, which is filled at BUILD time, and the build never sees .env.
// Every genuine webhook was refused and the login could not have worked.
const serverFiles = ['server/utils/shopify.ts', 'server/api/webhooks/compliance.post.ts', 'server/api/webhooks/app-uninstalled.post.ts']
check('the Shopify key and secret are read from the environment when used, never from build-time config',
  serverFiles.filter(path => /useRuntimeConfig\(\)\.shopify|config\.shopify/.test(read(path))), [])
check('  and nuxt.config holds no Shopify credentials to bake into a build', /SHOPIFY_API_(KEY|SECRET)/.test(read('nuxt.config.ts')), false)
process.env.SHOPIFY_API_KEY = 'k'
process.env.SHOPIFY_API_SECRET = 's'
const { shopifyCredentials } = await import('../server/utils/scopes')
check('  read at the moment of use', shopifyCredentials(), { apiKey: 'k', apiSecretKey: 's' })
check('a session token that fails verification is refused with 401, never a 500', /catch \{\s*throw createError\(\{ statusCode: 401/.test(read('server/utils/shopify.ts')), true)
// 2026-09-23: three size chart routes moved from Logistics answered with no
// login at all; production gave anyone 100 charts and 1688 supplier links.
// 2026-09-24: Nitro drops an import that binds nothing unless it is listed as
// having side effects, so the build shipped WITHOUT the Shopify Node adapter
// and every login failed ("Missing adapter implementation"). Only a real login
// showed it; scripts/verify-login-live.mjs does that against the build.
check('the Shopify Node adapter is kept in the build (nitro.moduleSideEffects)',
  /moduleSideEffects: \[[^\]]*'@shopify\/shopify-api\/adapters\/node'/.test(read('nuxt.config.ts')), true)
check('  and loaded again at start-up, the way Logistics does',
  /defineNitroPlugin\(async \(\) => \{\s*await import\('@shopify\/shopify-api\/adapters\/node'\)/.test(read('server/plugins/shopify-adapter.ts')), true)
check('  and the login code still imports it first', read('server/utils/shopify.ts').startsWith('import \'@shopify/shopify-api/adapters/node\''), true)
const guard = read('server/middleware/require-shop.ts')
check('a refused login is logged with its reason, the token masked out', guard.includes(String.raw`error.message.replace(/'[^']*'/g, '\'…\'')`) && guard.includes('console.warn(`[login] refused ${path}: ${reason}'), true)
check('one guard stands in front of every /api route', /path\.startsWith\('\/api\/'\)/.test(guard) && /statusCode: 401/.test(guard) && /isOpenPath\(path\)/.test(guard), true)
const { isOpenPath } = await import('../server/utils/open-paths')
check('  only the health check and Shopify\'s signed webhooks pass without a login',
  ['/api/health', '/api/webhooks/compliance', '/api/webhooks/app-uninstalled', '/api/size-charts/list', '/api/size-charts/summary', '/api/size-charts/1', '/api/shop', '/api/healthz', '/api/webhooksx', '/api/health/../size-charts/list'].map(isOpenPath),
  [true, true, true, false, false, false, false, false, false, false])
// 2026-09-24: once live, the logx test store (where `shopify app dev` put the
// app) would open the live app with a valid login, and the tables have no
// store column — a Sync there would replace the live store's product map.
const { shopAllowed } = await import('../server/utils/allowed-shops')
check('only the stores in ALLOWED_SHOPS get in; unset on the server means nobody, on a laptop anybody',
  [
    shopAllowed('tudoholic-com.myshopify.com', 'tudoholic-com.myshopify.com', false),
    shopAllowed('Tudoholic-com.myshopify.com ', ' tudoholic-com.myshopify.com, other.myshopify.com', false),
    shopAllowed('logx-ivsveium.myshopify.com', 'tudoholic-com.myshopify.com', false),
    shopAllowed('logx-ivsveium.myshopify.com', 'tudoholic-com.myshopify.com', true),
    shopAllowed('tudoholic-com.myshopify.com', '', false),
    shopAllowed('tudoholic-com.myshopify.com', undefined, false),
    shopAllowed('logx-ivsveium.myshopify.com', undefined, true),
  ],
  [true, true, false, false, false, false, true])
check('  the guard asks after the login is verified, and answers 403',
  guard.indexOf('shopAllowed(event.context.shop, process.env.ALLOWED_SHOPS, import.meta.dev)') > guard.indexOf('await verifiedShop(sessionToken)') && /statusCode: 403/.test(guard), true)
check('  .env.example names it, filled with the live store', /^ALLOWED_SHOPS=tudoholic-com\.myshopify\.com$/m.test(read('.env.example')), true)
const securityConfig = read('nuxt.config.ts')
check('nuxt-security\'s rate limiter is off (the review page\'s polling used up 150 per 5 minutes and locked staff out)', /rateLimiter: false/.test(securityConfig), true)
check('  and so is its XSS filter (it refused notes like "M -> L" with a bare 400)', /xssValidator: false/.test(securityConfig), true)
const compose = read('docker-compose.yml')
// 2026-09-23: 3003 was first chosen here, but chinaops.tudoholic.com already
// has it on the server (its web-server config) — the container could never start.
const hostPorts = [...compose.matchAll(/"127\.0\.0\.1:(\d+):3000"/g)].map(match => Number(match[1]))
check('the container listens on the server only, on 3004', hostPorts, [3004])
check('  never on a port the server\'s other sites hold (delivery 3001, Logistics 3002, chinaops 3003)', hostPorts.some(port => [3001, 3002, 3003].includes(port)), false)
check('  with its own database in its own folder', /DATABASE_URL: "\/app\/data\/db\.sqlite"/.test(compose) && /\.\/data:\/app\/data/.test(compose), true)
check('secrets never enter the image', read('.dockerignore').split('\n').includes('.env'), true)
check('secrets and the database never enter git', ['.env', '*.sqlite'].every(line => read('.gitignore').split('\n').includes(line)), true)

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

// node scripts/verify-login-live.mjs — a real login against the BUILT app.
//
// Run `pnpm build` first. Starts .output on 127.0.0.1:3998 with a made-up app
// key and secret and a throw-away database, signs a session token the way
// Shopify does, and checks: a real login is let in, a wrong signature and no
// login are refused, and the Shopify library has its Node adapter. On
// 2026-09-24 the build had dropped the adapter, so every login failed with
// "Missing adapter implementation" — offline checks could not see it.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const repo = fileURLToPath(new URL('..', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sc-login-'))
const database = join(scratch, 'db.sqlite')
const KEY = 'test-key-0000'
const SECRET = 'test-secret-0000'
const PORT = 3998
const base = `http://127.0.0.1:${PORT}`

const migrate = spawn('pnpm', ['exec', 'drizzle-kit', 'migrate'], { cwd: repo, env: { ...process.env, DATABASE_URL: database }, stdio: 'ignore' })
await new Promise(resolve => migrate.on('exit', resolve))

const child = spawn(process.execPath, [join(repo, '.output/server/index.mjs')], {
  cwd: scratch,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATABASE_URL: database,
    SHOPIFY_API_KEY: KEY,
    SHOPIFY_API_SECRET: SECRET,
    SHOPIFY_APP_URL: 'https://sizecharts.tudoholic.com',
    ALLOWED_SHOPS: 'logx-test.myshopify.com',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (chunk) => {
  log += chunk
})
child.stderr.on('data', (chunk) => {
  log += chunk
})
function finish(code) {
  child.kill('SIGTERM')
  rmSync(scratch, { recursive: true, force: true })
  process.exit(code)
}

for (let attempt = 0; attempt < 100; attempt++) {
  try {
    await fetch(`${base}/api/health`)
    break
  }
  catch {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

const b64 = text => Buffer.from(text).toString('base64url')
function sessionToken(secret = SECRET, shop = 'logx-test.myshopify.com') {
  const now = Math.floor(Date.now() / 1000)
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64(JSON.stringify({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: KEY, sub: '1', exp: now + 60, nbf: now - 5, iat: now - 5, jti: randomUUID(), sid: 'x' }))
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

const good = await fetch(`${base}/api/size-charts/summary`, { headers: { authorization: `Bearer ${sessionToken()}` } })
const wrong = await fetch(`${base}/api/size-charts/summary`, { headers: { authorization: `Bearer ${sessionToken('wrong')}` } })
const none = await fetch(`${base}/api/size-charts/summary`)
const otherStore = await fetch(`${base}/api/size-charts/summary`, { headers: { authorization: `Bearer ${sessionToken(SECRET, 'someone-else.myshopify.com')}` } })
const goodBody = await good.text()
// The review page polls while a job runs; 200 quick calls must never meet a
// "too many requests" wall (nuxt-security's default stopped at 150).
const statuses = []
for (let call = 0; call < 200; call++) {
  statuses.push((await fetch(`${base}/api/size-charts/summary`, { headers: { authorization: `Bearer ${sessionToken()}` } })).status)
}
const search = await fetch(`${base}/api/size-charts/list?q=${encodeURIComponent('length < 70 -> check')}`, { headers: { authorization: `Bearer ${sessionToken()}` } })

const results = {
  'a real login is let in': good.status === 200 && goodBody.includes('"success":true'),
  'a wrong signature is refused': wrong.status === 401,
  'no login is refused': none.status === 401,
  'a real login from a store not in ALLOWED_SHOPS is refused with 403': otherStore.status === 403,
  '200 quick calls in a row are all answered (no rate limit wall)': statuses.every(status => status === 200),
  'a search with < and > is not refused as an attack': search.status === 200,
  'the Shopify library has its Node adapter': !/Missing adapter/.test(log),
  'a refusal says why, never the token': /\[login\] refused \/api\/size-charts\/summary: [^\n]*'…'/.test(log),
}
let failures = 0
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
if (failures) console.log(`--- server log tail ---\n${log.split('\n').slice(-30).join('\n')}`)
console.log(failures === 0 ? '\nLOGIN WORKS' : `\n${failures} CHECK(S) FAILED`)
finish(failures === 0 ? 0 : 1)

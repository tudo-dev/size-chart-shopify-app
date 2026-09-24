// node scripts/verify-copy-from-logistics.mjs — tries the copy for real.
//
// Builds a pretend Logistics database from Logistics' OWN migrations (so its
// column order is Logistics', not ours), puts charts, pictures and jobs in it,
// makes a fresh database for this app with its own migrations, and runs
// scripts/copy-from-logistics.mjs against the two. Needs the Logistics repo
// beside this one (../logistics-shopify-app); without it, says so and stops.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const repo = fileURLToPath(new URL('..', import.meta.url))
const logisticsMigrations = join(repo, '../logistics-shopify-app/server/db/migrations')
if (!existsSync(logisticsMigrations)) {
  console.log('The Logistics repo is not beside this one, so the copy cannot be tried. Nothing checked.')
  process.exit(1)
}

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failures++
    console.log('      expected:', JSON.stringify(expected))
    console.log('      actual  :', JSON.stringify(actual))
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'copy-test-'))
const sourcePath = join(scratch, 'logistics', 'db.sqlite')
const targetPath = join(scratch, 'app', 'db.sqlite')
mkdirSync(join(scratch, 'logistics', 'size-chart-images'), { recursive: true })
mkdirSync(join(scratch, 'app'), { recursive: true })

// ---- the pretend Logistics database, from Logistics' own migrations ----
const source = new Database(sourcePath)
for (const file of ['0019_app-settings.sql', '0022_size-charts.sql', '0023_product-size-options.sql', '0024_size-chart-notices.sql']) {
  for (const statement of readFileSync(join(logisticsMigrations, file), 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) source.exec(statement)
  }
}
/** A row with every NOT NULL column filled, then the given values. */
function insertRow(db, table, values) {
  const row = {}
  for (const column of db.prepare(`pragma table_info(${table})`).all()) {
    if (column.pk && /INT/i.test(column.type)) continue // numbered by SQLite itself
    if (column.notnull && column.dflt_value === null) row[column.name] = /INT/i.test(column.type) ? 0 : 'x'
  }
  Object.assign(row, values)
  const names = Object.keys(row)
  db.prepare(`insert into ${table} (${names.join(', ')}) values (${names.map(() => '?').join(', ')})`).run(names.map(name => row[name]))
}
const picture = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6])
const pictureSha = createHash('sha256').update(picture).digest('hex')
writeFileSync(join(scratch, 'logistics', 'size-chart-images', `${pictureSha}.jpg`), picture)

insertRow(source, 'app_setting', { key: 'sizeCharts.autoRead', value: 'true' })
insertRow(source, 'app_setting', { key: 'sizeCharts.autoApprove', value: 'false' })
insertRow(source, 'app_setting', { key: 'payments.autoApply', value: 'true' })
insertRow(source, 'size_chart_upload', {})
// The path as Logistics' container wrote it — not a folder that exists here.
insertRow(source, 'size_chart', { source_product_id: '111', status: 'needs-review', image_path: `/app/server/db/size-chart-images/${pictureSha}.jpg`, image_sha256: pictureSha, notices: '["check the chest"]' })
insertRow(source, 'size_chart', { source_product_id: '222', status: 'needs-review', image_path: '/app/server/db/size-chart-images/gone.jpg', image_sha256: 'f'.repeat(64) })
insertRow(source, 'size_chart', { source_product_id: '333', status: 'no-image', image_path: null })
insertRow(source, 'size_chart_job', { kind: 'intake', status: 'done' })
insertRow(source, 'size_chart_job', { kind: 'read', status: 'running', started_at: '2026-09-24 05:00:00' })
insertRow(source, 'shopify_product_source', { shopify_product_id: 'gid://shopify/Product/1' })
insertRow(source, 'shopify_product_source', { shopify_product_id: 'gid://shopify/Product/2' })
source.close()

// ---- a fresh database for this app, from its own migrations ----
const migrate = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], { cwd: repo, env: { ...process.env, DATABASE_URL: targetPath }, encoding: 'utf8' })
check('this app\'s own migrations made a fresh database', migrate.status, 0)

const copy = (...extra) => spawnSync(process.execPath, [join(repo, 'scripts/copy-from-logistics.mjs'), sourcePath, ...extra], { env: { ...process.env, DATABASE_URL: targetPath }, encoding: 'utf8' })
const counts = () => {
  const db = new Database(targetPath, { readonly: true })
  const result = ['size_chart_upload', 'size_chart', 'size_chart_job', 'shopify_product_source'].map(table => db.prepare(`select count(*) as n from ${table}`).get().n)
  db.close()
  return result
}

const look = copy()
check('without --apply it only looks, and writes nothing', [look.status, counts()], [0, [0, 0, 0, 0]])
check('  and says what it would copy', /size_chart: 3 rows/.test(look.stdout) && /1 charts whose picture file is missing/.test(look.stdout), true)

const done = copy('--apply')
check('with --apply it copies, and every table then matches Logistics', [done.status, counts()], [0, [1, 3, 2, 2]])
check('  it says so', /Done\. Every table matches Logistics, and every chart's picture is in place\./.test(done.stdout), true)

const target = new Database(targetPath, { readonly: true })
const charts = Object.fromEntries(target.prepare('select source_product_id, image_path, notices, status from size_chart').all().map(row => [row.source_product_id, row]))
const newPicture = join(scratch, 'app', 'size-chart-images', `${pictureSha}.jpg`)
check('a chart\'s picture path now points into this app\'s picture folder, and the picture is there, unchanged',
  [charts['111'].image_path, existsSync(newPicture) && createHash('sha256').update(readFileSync(newPicture)).digest('hex')], [newPicture, pictureSha])
check('  a chart whose picture file was missing is left to be fetched again, not pointed at nothing', charts['222'].image_path, null)
check('  the column Logistics added later (notices) came across by name', charts['111'].notices, '["check the chest"]')
const jobs = target.prepare('select kind, status, error from size_chart_job order by id').all()
check('a job still running in Logistics arrives as failed, saying why (the page would wait on it forever)',
  [jobs[0].status, jobs[1].status, /still running in Tudoholic Logistics/.test(jobs[1].error ?? '')], ['done', 'failed', true])
const settings = Object.fromEntries(target.prepare('select key, value from app_setting').all().map(row => [row.key, row.value]))
check('only the size-chart switches come across, not Logistics\' other settings',
  [settings['sizeCharts.autoRead'], settings['sizeCharts.autoApprove'], settings['payments.autoApply']], ['true', 'false', undefined])
target.close()

const again = copy('--apply')
check('running it a second time refuses, and doubles nothing up', [again.status, /Copying again would double them up/.test(again.stdout), counts()], [1, true, [1, 3, 2, 2]])

const sourceAfter = new Database(sourcePath, { readonly: true })
check('Logistics\' database is left exactly as it was', [sourceAfter.prepare('select count(*) as n from size_chart').get().n, sourceAfter.prepare('select image_path from size_chart where source_product_id = \'111\'').get().image_path], [3, `/app/server/db/size-chart-images/${pictureSha}.jpg`])
sourceAfter.close()

// KEEP_COPY_TEST=1 keeps the pretend Logistics database, to try the copy inside the container too.
if (process.env.KEEP_COPY_TEST) console.log(`kept: ${scratch}`)
else rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nTHE COPY WORKS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

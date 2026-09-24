// Copies the size charts from Tudoholic Logistics into this app: the charts,
// the sheet uploads, the jobs, the product map, the two size-chart switches,
// and the supplier pictures. Logistics is only read, never changed.
//
//   node scripts/copy-from-logistics.mjs <Logistics db.sqlite>            look only
//   node scripts/copy-from-logistics.mjs <Logistics db.sqlite> --apply    copy
//
// This app's database is DATABASE_URL (in the container /app/data/db.sqlite).
// On the server, with this app stopped (docker compose stop):
//   docker compose run --rm --no-deps --entrypoint node \
//     -v /srv/apps/tudoholic-logistics-app/server/db:/logistics:ro \
//     -v "$PWD/scripts:/app/scripts:ro" \
//     sizecharts scripts/copy-from-logistics.mjs /logistics/db.sqlite [--apply]
//
// Two things a plain copy would get wrong:
//  - size_chart.image_path is a FULL path, and the picture folder is not in
//    the same place here (<db folder>/size-chart-images in both apps, but the
//    database folders differ) — every path is rewritten, every picture copied
//    and checked against its sha256.
//  - a job Logistics left "running" would keep this app's page waiting on it
//    forever — it is copied as failed, saying why.
// It refuses to run over charts already here, so it cannot double them up.
// The product map is derived from Shopify, so it is replaced, not merged.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const TABLES = ['size_chart_upload', 'size_chart', 'size_chart_job', 'shopify_product_source']
const MUST_BE_EMPTY = ['size_chart_upload', 'size_chart', 'size_chart_job']
const SETTING_PREFIX = 'sizeCharts.'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const sourcePath = args.find(arg => !arg.startsWith('--'))
const targetPath = process.env.DATABASE_URL
if (!sourcePath || !targetPath) {
  console.log('Usage: DATABASE_URL=<this app\'s db> node scripts/copy-from-logistics.mjs <Logistics db.sqlite> [--apply]')
  process.exit(1)
}
if (!existsSync(sourcePath)) {
  console.log(`No Logistics database at ${sourcePath}.`)
  process.exit(1)
}
if (!existsSync(targetPath)) {
  console.log(`No database at ${targetPath} — start this app once first, so its tables exist.`)
  process.exit(1)
}

const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
const target = new Database(targetPath, { fileMustExist: true })
const sourceImages = join(dirname(sourcePath), 'size-chart-images')
const targetImages = join(dirname(targetPath), 'size-chart-images')

const columnsOf = (db, table) => db.prepare(`pragma table_info(${table})`).all().map(column => column.name)
const count = (db, table) => db.prepare(`select count(*) as n from ${table}`).get().n
const sha256Of = path => createHash('sha256').update(readFileSync(path)).digest('hex')

// Both apps must have every table, with the same columns.
for (const table of TABLES) {
  const from = columnsOf(source, table)
  const to = columnsOf(target, table)
  if (from.length === 0) {
    console.log(`Logistics has no ${table} table — is this the Logistics database?`)
    process.exit(1)
  }
  if (to.length === 0) {
    console.log(`This app has no ${table} table — start it once first, so its migrations run.`)
    process.exit(1)
  }
  const missing = from.filter(column => !to.includes(column))
  if (missing.length > 0) {
    console.log(`${table}: Logistics has columns this app does not (${missing.join(', ')}). Nothing was copied.`)
    process.exit(1)
  }
}
const alreadyHere = MUST_BE_EMPTY.filter(table => count(target, table) > 0)
if (alreadyHere.length > 0) {
  console.log(`This app already has rows in ${alreadyHere.join(', ')}. Copying again would double them up, so nothing was copied.`)
  process.exit(1)
}

// Read everything first, and work out each picture's new place.
const rows = Object.fromEntries(TABLES.map(table => [table, source.prepare(`select * from ${table}`).all()]))
const settings = source.prepare('select * from app_setting where key like ?').all(`${SETTING_PREFIX}%`)
const pictures = []
let picturesMissing = 0
let picturesWrong = 0
for (const chart of rows.size_chart) {
  if (!chart.image_path) continue
  const file = basename(chart.image_path)
  const from = join(sourceImages, file)
  const to = join(targetImages, file)
  if (!existsSync(from)) {
    picturesMissing++
    chart.image_path = null // the next Sync fetches it again
    continue
  }
  if (chart.image_sha256 && sha256Of(from) !== chart.image_sha256) {
    picturesWrong++
    chart.image_path = null
    continue
  }
  pictures.push({ from, to })
  chart.image_path = to
}
let jobsStopped = 0
for (const job of rows.size_chart_job) {
  if (job.status !== 'running') continue
  jobsStopped++
  job.status = 'failed'
  job.error = 'it was still running in Tudoholic Logistics when the size charts moved here'
  job.finished_at = job.finished_at ?? job.started_at
}
const uniquePictures = [...new Map(pictures.map(picture => [picture.to, picture])).values()]

console.log(apply ? 'Copying from Logistics:' : 'Looking only (add --apply to copy):')
for (const table of TABLES) console.log(`  ${table}: ${rows[table].length} rows`)
console.log(`  size-chart switches: ${settings.map(setting => `${setting.key}=${setting.value}`).join(', ') || 'none set'}`)
console.log(`  pictures: ${uniquePictures.length} files to copy${picturesMissing ? `, ${picturesMissing} charts whose picture file is missing (they will be fetched again)` : ''}${picturesWrong ? `, ${picturesWrong} whose picture no longer matches its fingerprint (fetched again)` : ''}`)
if (jobsStopped) console.log(`  ${jobsStopped} job(s) still running in Logistics are copied as failed`)
if (!apply) process.exit(0)

// Pictures first, each checked after copying; then the rows in one transaction.
mkdirSync(targetImages, { recursive: true })
for (const picture of uniquePictures) {
  if (!existsSync(picture.to)) copyFileSync(picture.from, picture.to)
  if (sha256Of(picture.to) !== sha256Of(picture.from)) {
    console.log(`A copied picture does not match its original: ${basename(picture.to)}. Nothing was written to the database.`)
    process.exit(1)
  }
}
const insertAll = target.transaction(() => {
  target.prepare('delete from shopify_product_source').run()
  for (const table of TABLES) {
    const columns = columnsOf(source, table)
    const insert = target.prepare(`insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`)
    for (const row of rows[table]) insert.run(columns.map(column => row[column]))
  }
  const settingColumns = columnsOf(source, 'app_setting')
  const upsert = target.prepare(`insert or replace into app_setting (${settingColumns.join(', ')}) values (${settingColumns.map(() => '?').join(', ')})`)
  for (const setting of settings) upsert.run(settingColumns.map(column => setting[column]))
})
insertAll()

// Read back: every table holds exactly what Logistics has.
const wrong = TABLES.filter(table => count(target, table) !== rows[table].length)
if (wrong.length > 0) {
  console.log(`After copying, these do not match Logistics: ${wrong.join(', ')}.`)
  process.exit(1)
}
const unreadable = target.prepare('select image_path from size_chart where image_path is not null').all().filter(row => !existsSync(row.image_path)).length
console.log(`Done. Every table matches Logistics, and ${unreadable === 0 ? 'every chart\'s picture is in place' : `${unreadable} chart(s) point to a missing picture`}.`)
process.exit(unreadable === 0 ? 0 : 1)

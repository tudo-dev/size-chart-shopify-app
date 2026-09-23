/**
 * Verify the size chart feature end to end, short of Shopify and the reader.
 *
 *   pnpm size-charts:verify        (or: tsx scripts/verify-size-charts.ts)
 *
 * ## What is being defended
 *
 * The listing team's sheet is read by 1688 id, never by row position; a
 * changed picture link queues the row again and an unchanged one does not;
 * every Chinese heading maps to one English word; a cell is converted here
 * (尺 to cm, 斤 to kg, mm to cm, cm to inches) and never by the reader; the
 * app writes down every reason a person should look; the SVG prints the
 * same figures the storefront gets; the lists, the counts and the actions
 * behave on a scratch copy of the database; and one job runs at a time.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { normaliseSourceProductId, parseSizeChartWorkbook, sourceIdFromUrl } from './lib/size-chart-sheet'
import type { XlsxSheet } from './lib/xlsx'
import { glossaryForPrompt, MEASURES, measureFromHeading, measureLabel } from '../shared/size-chart/glossary'
import { cmToInches, formatValue, kgToPounds, parseCell } from '../shared/size-chart/values'
import { chartSummary, normaliseChart, pivotToSoldSizes, READ_CHART_SCHEMA, sizeKey, sizesOf } from '../shared/size-chart/chart'
import type { ReadChart } from '../shared/size-chart/chart'
import { escapeXml, renderChartSvg } from '../shared/size-chart/render-svg'

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
function section(title: string) {
  console.log(`\n${title}`)
}

const repo = fileURLToPath(new URL('..', import.meta.url))
const scratchDir = mkdtempSync(join(tmpdir(), 'size-charts-'))
const scratchDb = join(scratchDir, 'db.sqlite')
// A fresh database built by this app's own migrations — exactly what the
// container builds on the server. (In Logistics this was a copy of its
// database with the three size chart migrations applied on top.)
migrate(drizzle(new Database(scratchDb)), { migrationsFolder: join(repo, 'server/db/migrations') })
process.env.DATABASE_URL = scratchDb

const store = await import('../server/utils/size-chart-store')
const products = await import('../server/utils/size-chart-products')
const images = await import('../server/utils/size-chart-images')
const jobs = await import('../server/utils/size-chart-jobs')
const reader = await import('../server/utils/size-chart-reader')
const settings = await import('../server/utils/app-settings')

// ---------------------------------------------------------------------------
section('The listing team\'s sheet')

const HEADER = ['Source Product ID (product.metafields.external.source_product_id)', 'Type', 'Tags', 'Store', '1688 Image link for Size chart', '1688 Link', 'Remarks']
const chartSheet: XlsxSheet = {
  name: 'Size chart',
  rows: [
    HEADER,
    ['957039814706', 'Trucker Jackets', 'MENS', 'MENS', 'https://cbu01.alicdn.com/img/ibank/a.jpg', 'https://detail.1688.com/offer/957039814706.html', ''],
    ['9.59223261699E11', 'Sneakers', 'MENS', 'MENS', '', 'https://detail.1688.com/offer/959223261699.html', 'Not avaialble'],
    ['', 'Hoodies', 'WOMENS', 'WOMENS', 'https://cbu01.alicdn.com/img/ibank/b.jpg?__r__=1', 'https://detail.1688.com/offer/681871315717.html', ''],
    ['957039814706', 'Trucker Jackets', 'MENS', 'MENS', 'https://cbu01.alicdn.com/img/ibank/dup.jpg', 'https://detail.1688.com/offer/957039814706.html', ''],
    ['111111111111', 'T-Shirts', 'MENS', 'MENS', 'https://cbu01.alicdn.com/img/ibank/c.jpg', 'https://detail.1688.com/offer/222222222222.html', ''],
    ['', '', 'MENS', 'MENS', '', '', ''],
    ['', '', 'WOMENS', 'WOMENS', '', '', ''],
    ['abc', 'T-Shirts', 'MENS', 'MENS', 'https://cbu01.alicdn.com/img/ibank/d.jpg', '', ''],
  ],
}
const productsSheet: XlsxSheet = {
  name: 'products_export',
  rows: [
    ['Handle', 'Title', 'Body (HTML)', 'Type', 'Source Product ID (product.metafields.external.source_product_id)', 'Status'],
    ['mens-retro-denim-jacket', 'Men’s Retro Denim Jacket', '<p>x</p>', 'Trucker Jackets', '9.57039814706E11', 'active'],
    ['mens-retro-denim-jacket', '', '', '', '', ''],
    ['mens-retro-denim-jacket', '', '', '', '', ''],
    ['womens-hoodie', 'Women’s Hoodie', '', 'Hoodies', '681871315717', 'active'],
  ],
}
const parsed = parseSizeChartWorkbook([productsSheet, chartSheet])
check('the chart tab is found by its columns, whatever tab comes first', parsed.sheetName, 'Size chart')
check('rows are kept by 1688 id: 3 usable rows', parsed.rows.map(r => r.sourceProductId), ['957039814706', '959223261699', '681871315717'])
check('a float-formatted id is read whole', normaliseSourceProductId('9.59223261699E11'), '959223261699')
check('a 13-digit float id keeps every digit', normaliseSourceProductId('1.004579020186E12'), '1004579020186')
check('an id with a trailing .0 is read whole', normaliseSourceProductId('957039814706.0'), '957039814706')
check('a missing id is taken from the 1688 link', parsed.rows[2]!.sourceProductId, '681871315717')
check('the id in a 1688 link', sourceIdFromUrl('https://detail.1688.com/offer/984198921197.html'), '984198921197')
check('store comes through upper case', parsed.rows[2]!.store, 'WOMENS')
check('the picture link keeps its query string', parsed.rows[2]!.imageUrl, 'https://cbu01.alicdn.com/img/ibank/b.jpg?__r__=1')
check('a row without a picture has no link and keeps its remark', [parsed.rows[1]!.imageUrl, parsed.rows[1]!.remark], [null, 'Not avaialble'])
check('padding rows with only a store word are not reported', parsed.skipped.some(s => s.rowNumber === 7 || s.rowNumber === 8), false)
check('a duplicate id, a disagreeing link and a non-id are reported', parsed.skipped.map(s => s.reason), [
  '957039814706 is already on row 2',
  'the id 111111111111 and the 1688 link (222222222222) disagree',
  '"abc" is not a 1688 product id',
])
check('handles come from the products tab, once per product', [...parsed.products.entries()].map(([id, list]) => [id, list.map(p => p.handle)]), [
  ['957039814706', ['mens-retro-denim-jacket']],
  ['681871315717', ['womens-hoodie']],
])
check('the products tab is named', parsed.productsSheetName, 'products_export')
let threw = ''
try {
  parseSizeChartWorkbook([{ name: 'Sheet1', rows: [['A', 'B'], ['1', '2']] }])
}
catch (error) {
  threw = error instanceof Error ? error.message : String(error)
}
check('a workbook without the chart columns is refused with the sheet names', threw.includes('Sheets found: Sheet1'), true)

// ---------------------------------------------------------------------------
section('Cells: reading what was printed, printing it in two systems')

const cell = (raw: string, family: 'length' | 'weight' | 'garmentWeight' | 'count' | 'text', hint: 'cm' | 'mm' | 'inch' | 'chi' | 'jin' | 'kg' | 'g' | 'none' | 'unknown') => {
  const parsed = parseCell(raw, family, hint)
  return [formatValue(parsed.value, family, 'metric'), formatValue(parsed.value, family, 'imperial'), parsed.assumed ? 'assumed' : '']
}
check('108 cm → 42.5 in', cell('108', 'length', 'cm'), ['108', '42.5', ''])
check('49.5 cm → 19.5 in', cell('49.5', 'length', 'cm'), ['49.5', '19.5', ''])
check('1尺7-1尺9 (Chinese feet) → 56.7-63.3 cm', cell('1尺7-1尺9', 'length', 'cm'), ['56.7-63.3', '22.3-24.9', ''])
check('2尺-2尺2 → 66.7-73.3 cm', cell('2尺-2尺2', 'length', 'cm'), ['66.7-73.3', '26.3-28.9', ''])
check('2尺2寸 → 73.3 cm', cell('2尺2寸', 'length', 'unknown'), ['73.3', '28.9', ''])
check('160-170CM with no column unit', cell('160-170CM', 'length', 'unknown'), ['160-170', '63-66.9', ''])
check('160～170 with a full-width tilde', cell('160～170', 'length', 'cm'), ['160-170', '63-66.9', ''])
check('245 mm (shoe foot length) → 24.5 cm', cell('245', 'length', 'mm'), ['24.5', '9.6', ''])
check('25.5cm in an mm column: the cell wins', cell('25.5cm', 'length', 'mm'), ['25.5', '10', ''])
check('24" → 61 cm', cell('24"', 'length', 'unknown'), ['61', '24', ''])
check('80-100斤 → 40-50 kg → 88-110 lb', cell('80-100斤', 'weight', 'unknown'), ['40-50', '88-110', ''])
check('100斤以下 → up to 50 kg', cell('100斤以下', 'weight', 'jin'), ['up to 50', 'up to 110', ''])
check('100斤以上 → 50 kg or more', cell('100斤以上', 'weight', 'unknown'), ['50 or more', '110 or more', ''])
check('90-110 with no unit anywhere is taken as 斤 and said so', cell('90-110', 'weight', 'unknown'), ['45-55', '99-121', 'assumed'])
check('40-47.5kg → 88-105 lb', cell('40-47.5kg', 'weight', 'unknown'), ['40-47.5', '88-105', ''])
check('45-57.5 in a kg column', cell('45-57.5', 'weight', 'kg'), ['45-57.5', '99-127', ''])
check('640 g garment weight → 22.6 oz', cell('640', 'garmentWeight', 'g'), ['640', '22.6', ''])
check('a size code 39.5 is never converted', cell('39.5', 'count', 'none'), ['39.5', '39.5', ''])
check('an empty cell prints as nothing', cell('', 'length', 'cm'), ['', '', ''])
check('a dash is an empty cell', cell('—', 'length', 'cm'), ['', '', ''])
check('a spec code stays text', cell('160/80A', 'text', 'none'), ['160/80A', '160/80A', ''])
check('words under a number column stay text (and are flagged later)', cell('均码', 'length', 'cm'), ['均码', '均码', ''])
check('full-width digits are read', cell('１０８', 'length', 'cm'), ['108', '42.5', ''])
check('inches to the nearest quarter, when the owner asks', [cmToInches(62, 'quarter'), cmToInches(108, 'quarter'), cmToInches(100, 'quarter')], ['24½', '42½', '39¼'])
check('inches to one decimal by default', [cmToInches(108), cmToInches(56.7), cmToInches(50)], ['42.5', '22.3', '19.7'])
check('kg to whole pounds', [kgToPounds(50), kgToPounds(47.5)], ['110', '105'])

// ---------------------------------------------------------------------------
section('The word list')

check('胸围 is Chest on a men\'s product and Bust on a women\'s', [measureLabel('chest', 'MENS'), measureLabel('chest', 'WOMENS'), measureLabel('chest', null)], ['Chest', 'Bust', 'Chest'])
check('every measure has an English label and at least one Chinese spelling', Object.values(MEASURES).every(m => m.label.length > 0 && m.original.length > 0), true)
check('the prompt lists the supplier\'s own words', glossaryForPrompt().includes('chest: 胸围 / 胸宽 (Chest)'), true)
check('the reader\'s schema closes every object', JSON.stringify(READ_CHART_SCHEMA).split('"type":"object"').length - 1, JSON.stringify(READ_CHART_SCHEMA).split('"additionalProperties":false').length - 1)
check('the schema offers the word-list keys and other', (READ_CHART_SCHEMA.properties.tables.items.properties.columns.items.properties.measure.enum as readonly string[]).includes('other'), true)

// ---------------------------------------------------------------------------
section('From the reader\'s transcript to the finished chart')

const jacket: ReadChart = {
  isSizeChart: true,
  imageComplete: true,
  tables: [
    {
      kind: 'garment',
      titleOriginal: '产品信息',
      titleEnglish: 'Product information',
      sizeHeading: '尺寸',
      columns: [
        { original: '胸围', measure: 'chest', english: 'Chest', unit: 'cm' },
        { original: '肩宽', measure: 'shoulder', english: 'Shoulder', unit: 'cm' },
        { original: '后中长', measure: 'backLength', english: 'Back length', unit: 'cm' },
      ],
      rows: [
        { size: 'S', cells: ['108', '55', '66'] },
        { size: 'M', cells: ['112', '57', '68'] },
        { size: 'XL', cells: ['120', '60', '71'] },
        { size: 'XXL', cells: ['124', '31', '72'] },
      ],
    },
    {
      kind: 'fit',
      titleOriginal: '',
      titleEnglish: '',
      sizeHeading: '尺码',
      columns: [
        { original: '身高', measure: 'height', english: 'Height', unit: 'cm' },
        { original: '体重', measure: 'weight', english: 'Weight', unit: 'jin' },
      ],
      rows: [
        { size: 'S', cells: ['160-170', '80-100'] },
        { size: 'M', cells: ['165-175', '100-115'] },
      ],
    },
  ],
  notes: ['Measured flat by hand; allow 2-4 cm.'],
  warnings: [],
}
const outcome = normaliseChart(jacket, { store: 'MENS' })
check('table titles are the app\'s, not the supplier\'s', outcome.chart.tables.map(t => t.title), ['Measurements', 'Recommended height and weight'])
check('headings are English with the unit under them', outcome.chart.tables[0]!.columns, [
  { label: 'Size', metric: null, imperial: null },
  { label: 'Chest', metric: 'cm', imperial: 'in' },
  { label: 'Shoulder', metric: 'cm', imperial: 'in' },
  { label: 'Back length', metric: 'cm', imperial: 'in' },
])
check('a row carries both systems', outcome.chart.tables[0]!.rows[0], { size: 'S', metric: ['108', '55', '66'], imperial: ['42.5', '21.7', '26'] })
check('weight in 斤 becomes kg and lb', outcome.chart.tables[1]!.rows[0], { size: 'S', metric: ['160-170', '40-50'], imperial: ['63-66.9', '88-110'] })
check('the supplier\'s 31-after-60 typo is flagged', outcome.assessment.flags, ['Shoulder: 60 then 31 for size XXL looks like a typo in the supplier\'s table.'])
check('one flag costs 0.15 and stops auto-approval', [outcome.assessment.confidence, outcome.assessment.autoApprove], [0.85, false])
check('notes are kept', outcome.chart.notes, ['Measured flat by hand; allow 2-4 cm.'])
check('the summary line', chartSummary(outcome.chart), '2 tables, 4 sizes (S to XXL)')
check('sizes in printed order, once each', sizesOf(outcome.chart), ['S', 'M', 'XL', 'XXL'])

const clean: ReadChart = { ...jacket, tables: [{ ...jacket.tables[0]!, rows: jacket.tables[0]!.rows.slice(0, 3) }] }
const cleanOutcome = normaliseChart(clean, { store: 'WOMENS' })
check('nothing stood out: confidence 1 and auto-approval', [cleanOutcome.assessment.flags, cleanOutcome.assessment.confidence, cleanOutcome.assessment.autoApprove], [[], 1, true])
check('the same heading reads Bust on a women\'s product', cleanOutcome.chart.tables[0]!.columns[1]!.label, 'Bust')

const report: ReadChart = { isSizeChart: false, imageComplete: true, tables: [], notes: [], warnings: ['This is a try-on report, not a size chart.'] }
const reportOutcome = normaliseChart(report)
check('a try-on report is not a chart: confidence 0, never approved, both reasons written', [reportOutcome.assessment.confidence, reportOutcome.assessment.autoApprove, reportOutcome.assessment.flags], [0, false, [
  'The picture is not a size chart, or no table of sizes could be found in it.',
  'The reader noted: This is a try-on report, not a size chart.',
]])

const odd: ReadChart = {
  isSizeChart: true,
  imageComplete: false,
  tables: [{
    kind: 'garment',
    titleOriginal: '',
    titleEnglish: '',
    sizeHeading: '尺码',
    columns: [
      { original: '袖笼', measure: 'other', english: 'armhole', unit: 'cm' },
      { original: '体重', measure: 'weight', english: 'Weight', unit: 'unknown' },
    ],
    rows: [
      { size: 'M', cells: ['22', '90-110'] },
      { size: 'M', cells: ['均码', '100-120', 'extra'] },
    ],
  }],
  notes: [],
  warnings: [],
}
const oddOutcome = normaliseChart(odd)
check('cut-off picture, unknown heading, assumed unit, duplicate size, extra cell, unreadable number: every reason written', oddOutcome.assessment.flags, [
  'The picture looks cut off; part of a table may be missing.',
  'The column "袖笼" (Armhole) is not in the app\'s word list; check its heading.',
  'Weight: no unit was printed for "90-110", so it was taken as 斤 (half kilos).',
  'The size "M" appears twice in "Measurements".',
  'The row for size "M" in "Measurements" has more cells than headings.',
  '"均码" under Armhole (size M) could not be read as a number.',
])
check('an unknown heading still prints its translation with units', oddOutcome.chart.tables[0]!.columns[1], { label: 'Armhole', metric: 'cm', imperial: 'in' })
check('confidence falls with every flag, never below zero', oddOutcome.assessment.confidence, 0.1)

const shoes: ReadChart = {
  isSizeChart: true,
  imageComplete: true,
  tables: [{
    kind: 'shoe',
    titleOriginal: '尺码对照表',
    titleEnglish: 'Size chart',
    sizeHeading: '鞋码',
    columns: [
      { original: '脚长（MM）', measure: 'footLength', english: 'Foot length', unit: 'mm' },
      { original: '欧码', measure: 'eu', english: 'EU', unit: 'none' },
    ],
    rows: [{ size: '39', cells: ['245', '39.5'] }, { size: '40', cells: ['250', '40'] }],
  }],
  notes: [],
  warnings: [],
}
const shoeOutcome = normaliseChart(shoes)
check('shoe table: mm to cm and inches, the EU code untouched and unitless', [shoeOutcome.chart.tables[0]!.title, shoeOutcome.chart.tables[0]!.columns[2], shoeOutcome.chart.tables[0]!.rows[0]], ['Shoe sizes', { label: 'EU size', metric: null, imperial: null }, { size: '39', metric: ['24.5', '39.5'], imperial: ['9.6', '39.5'] }])

// ---------------------------------------------------------------------------
section('The size column is the size a customer can pick')

check('one size, many spellings', ['38.0', ' M ', 'XXL', '2XL', 'S (recommended below 47.5kg)', 'XS（90~105）', 'S【below 50kg】', 'M 50.00 kg-62.50 kg', 'One size fits all', '均码', '160/84A', 'XXXL'].map(sizeKey), ['38', 'm', '2xl', '2xl', 's', 'xs', 's', 'm', 'onesize', 'onesize', '160/84a', '3xl'])
check('a printed heading is found in the word list', [measureFromHeading('脚长CM'), measureFromHeading('尺码'), measureFromHeading('中国旧码'), measureFromHeading('中国码'), measureFromHeading('标准码'), measureFromHeading('国际码'), measureFromHeading('')], ['footLength', null, 'cnOld', 'cn', 'standardSize', 'intlSize', null])

// The first live picture (2026-09-20): a women's sneaker chart printed sideways,
// foot length along the top; the shop sells sizes 30-40.
const sneakers: ReadChart = {
  isSizeChart: true,
  imageComplete: true,
  tables: [{
    kind: 'shoe',
    titleOriginal: '',
    titleEnglish: '',
    sizeHeading: '脚长CM',
    columns: [
      { original: '中国码', measure: 'cn', english: 'CN size', unit: 'none' },
      { original: '中国旧码', measure: 'cnOld', english: 'Old China size', unit: 'none' },
      { original: '美国码', measure: 'us', english: 'US size', unit: 'none' },
      { original: '英国码', measure: 'uk', english: 'UK size', unit: 'none' },
      { original: '欧洲码', measure: 'eu', english: 'EU size', unit: 'none' },
    ],
    rows: [
      { size: '22.0', cells: ['220', '34', '5', '3', '35'] },
      { size: '22.5', cells: ['225', '35', '5', '3', '36'] },
      { size: '23.0', cells: ['230', '36', '6', '4', '37'] },
      { size: '23.5', cells: ['235', '37', '6', '5', '37'] },
      { size: '24.0', cells: ['240', '38', '7', '5', '38'] },
      { size: '24.5', cells: ['245', '39', '8', '6', '39'] },
      { size: '25.0', cells: ['250', '40', '8', '6', '40'] },
      { size: '25.5', cells: ['255', '41', '9', '7', '40'] },
    ],
  }],
  notes: ['All data above is measured in centimeters.'],
  warnings: [],
}
const sold = ['34', '35', '36', '37', '38', '39', '40', '30', '31', '32', '33']
const pivot = pivotToSoldSizes(sneakers.tables[0]!, sold)
check('the size column becomes the code the shop sells (old China 34-41), not EU, which repeats 37 and 40', pivot.table.rows.map(row => row.size), ['34', '35', '36', '37', '38', '39', '40', '41'])
check('the foot length moves to the first measurement column, in cm from its heading', [pivot.table.columns[0], pivot.table.rows[0]!.cells], [{ original: '脚长CM', measure: 'footLength', english: 'Foot length', unit: 'cm' }, ['22.0', '220', '5', '3', '35']])
check('the moved-in column is gone from the middle', pivot.table.columns.map(column => column.measure), ['footLength', 'cn', 'us', 'uk', 'eu'])
check('the swap is explained', pivot.note, 'The sizes now come from "中国旧码", which is what the shop sells, not from foot length; foot length is a column like the others.')

const sneakerOutcome = normaliseChart(sneakers, { store: 'WOMENS', sizesSold: sold })
check('the finished chart: Size, then Foot length in cm and inches, then the codes', sneakerOutcome.chart.tables[0]!.columns.map(column => [column.label, column.metric, column.imperial]), [
  ['Size', null, null], ['Foot length', 'cm', 'in'], ['CN size', null, null], ['US size', null, null], ['UK size', null, null], ['EU size', null, null],
])
check('size 38 is one row a customer can find: 24 cm, 9.4 in', sneakerOutcome.chart.tables[0]!.rows[4], { size: '38', metric: ['24', '240', '7', '5', '38'], imperial: ['9.4', '240', '7', '5', '38'] })
check('the swap is a notice, not a doubt', sneakerOutcome.assessment.notices, ['The sizes now come from "中国旧码", which is what the shop sells, not from foot length; foot length is a column like the others.'])
check('the sizes on sale the chart does not cover are the one flag', sneakerOutcome.assessment.flags, ['The shop sells sizes 30, 31, 32, 33 that this chart does not show.'])
check('…so it waits for a person at 85%', [sneakerOutcome.assessment.confidence, sneakerOutcome.assessment.autoApprove], [0.85, false])
check('中国旧码 is in the word list now, so it is not flagged', sneakerOutcome.assessment.flags.some(flag => flag.includes('word list')), false)

const noSold = normaliseChart(sneakers, { store: 'WOMENS' })
check('without the shop\'s sizes, a foot-length size column still gives way: EU repeats, so old China leads', noSold.chart.tables[0]!.rows.map(row => row.size), ['34', '35', '36', '37', '38', '39', '40', '41'])
check('…and nothing is flagged, since nothing is known to be missing', noSold.assessment.flags, [])

const rightSizes = normaliseChart(sneakers, { sizesSold: ['22', '22.5', '23', '23.5'] })
check('when the shop sells by foot length, the column stays put', [rightSizes.chart.tables[0]!.rows[0]!.size, rightSizes.assessment.notices], ['22.0', []])

// The second live picture (2026-09-20): 国际码 215-250 led, 标准码 33-40 was a
// column the word list did not know, and the shop sells 35-40.
const heightIncreasing: ReadChart = {
  isSizeChart: true,
  imageComplete: true,
  tables: [{
    kind: 'shoe',
    titleOriginal: '国际尺码对照表',
    titleEnglish: 'Size reference',
    sizeHeading: '国际码',
    columns: [
      { original: '标准码', measure: 'other', english: 'Standard size', unit: 'none' },
      { original: '脚长(CM)', measure: 'footLength', english: 'Foot length', unit: 'cm' },
      { original: '脚宽(CM)', measure: 'footWidth', english: 'Foot width', unit: 'cm' },
    ],
    rows: [
      { size: '215', cells: ['33', '21.0-21.4', '7.5-7.9'] },
      { size: '220', cells: ['34', '21.5-22.0', '8.0-8.4'] },
      { size: '225', cells: ['35', '22.1-22.5', '8.5'] },
      { size: '230', cells: ['36', '22.6-23.0', '8.6-9.0'] },
      { size: '235', cells: ['37', '23.1-23.5', '9.1'] },
      { size: '240', cells: ['38', '23.6-24.0', '9.2-9.5'] },
      { size: '245', cells: ['39', '24.1-24.5', '9.6-10.0'] },
      { size: '250', cells: ['40', '24.6-25.0', '10.1-10.5'] },
    ],
  }],
  notes: [],
  warnings: [],
}
const heightOutcome = normaliseChart(heightIncreasing, { store: 'WOMENS', sizesSold: ['35', '36', '37', '38', '39', '40'] })
check('a column the word list did not know still becomes the size column when it is what the shop sells', heightOutcome.chart.tables[0]!.rows.map(row => row.size), ['33', '34', '35', '36', '37', '38', '39', '40'])
check('the millimetre code becomes an unconverted column; foot length and width carry cm and inches', heightOutcome.chart.tables[0]!.columns.map(column => [column.label, column.metric, column.imperial]), [
  ['Size', null, null], ['International size', null, null], ['Foot length', 'cm', 'in'], ['Foot width', 'cm', 'in'],
])
check('size 38: 240, 23.6-24 cm (9.3-9.4 in), 9.2-9.5 cm (3.6-3.7 in)', heightOutcome.chart.tables[0]!.rows[5], { size: '38', metric: ['240', '23.6-24', '9.2-9.5'], imperial: ['240', '9.3-9.4', '3.6-3.7'] })
check('every size on sale is covered, the unknown-word flag is gone: nothing to check', heightOutcome.assessment.flags, [])
check('…and the swap is the one notice', heightOutcome.assessment.notices, ['The sizes now come from "标准码", which is what the shop sells, not from international size; international size is a column like the others.'])
const heightNoSold = normaliseChart({ ...heightIncreasing, tables: [{ ...heightIncreasing.tables[0]!, columns: [{ ...heightIncreasing.tables[0]!.columns[0]!, measure: 'standardSize' }, ...heightIncreasing.tables[0]!.columns.slice(1)] }] })
check('without the shop\'s sizes, a three-figure size column (215…) still gives way to the standard size', heightNoSold.chart.tables[0]!.rows.map(row => row.size), ['33', '34', '35', '36', '37', '38', '39', '40'])
check('…with the note saying so without claiming to know what the shop sells', heightNoSold.assessment.notices, ['The sizes now come from "标准码", not from international size; international size is a column like the others.'])

const garmentSold = normaliseChart(jacket, { store: 'MENS', sizesSold: ['S (recommended below 47.5kg)', 'M', 'XL', 'XXL', '3XL'] })
check('a garment chart keeps its letter sizes; the note in a variant name does not hide the match', garmentSold.chart.tables[0]!.rows.map(row => row.size), ['S', 'M', 'XL', 'XXL'])
check('…and the size on sale it lacks is flagged beside the supplier typo', garmentSold.assessment.flags, [
  'Shoulder: 60 then 31 for size XXL looks like a typo in the supplier\'s table.',
  'The shop sells size 3XL that this chart does not show.',
])
const wrongProduct = normaliseChart(clean, { sizesSold: ['38', '39', '40'] })
check('a chart with none of the sizes on sale is called out as possibly another product\'s', wrongProduct.assessment.flags, ['This chart shows none of the sizes the shop sells (38, 39, 40); it may belong to another product.'])

check('the Size option is read off a Shopify product, whatever it is called', [
  products.sizeOptionsOf({ options: [{ name: 'Color', optionValues: [{ name: 'White' }] }, { name: 'Size', optionValues: [{ name: '34' }, { name: '35' }, { name: ' ' }] }] }),
  products.sizeOptionsOf({ options: [{ name: 'Shoe size', optionValues: [{ name: '40' }] }] }),
  products.sizeOptionsOf({ options: [{ name: 'Color', optionValues: [{ name: 'Red' }] }] }),
  products.sizeOptionsOf({ options: null }),
], [['34', '35'], ['40'], null, null])
check('…and back out of the stored JSON', [products.sizesSoldOf({ sizeOptions: '["S","M"]' }), products.sizesSoldOf({ sizeOptions: null }), products.sizesSoldOf({ sizeOptions: 'not json' }), products.sizesSoldOf(null)], [['S', 'M'], [], [], []])

// ---------------------------------------------------------------------------
section('The picture the app draws')

const svg = renderChartSvg(outcome.chart, { title: 'Men\'s Retro Denim Jacket <Fleece & Lined>', subtitle: 'Trucker Jackets' })
check('it is one SVG document', [svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), svg.trimEnd().endsWith('</svg>')], [true, true])
check('the title is escaped, not injected', svg.includes('Men&apos;s') || svg.includes('Retro Denim Jacket &lt;Fleece &amp; Lined&gt;'), true)
check('headings and both systems are printed', ['>Chest<', '>cm · in<', '>108<', '>42.5<', '>Recommended height and weight<', '>88-110<'].every(needle => svg.includes(needle)), true)
check('the supplier note and our name are at the foot', [svg.includes('Measured flat by hand'), svg.includes('tudoholic.com · centimetres with inches below')], [true, true])
check('the same chart always draws the same picture', renderChartSvg(outcome.chart, { title: 'x' }) === renderChartSvg(outcome.chart, { title: 'x' }), true)
check('escapeXml', escapeXml('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;')

// ---------------------------------------------------------------------------
section('Pictures: what kind, how big, kept once')

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]),
  Buffer.from('IHDR', 'ascii'),
  Buffer.from([0x00, 0x00, 0x03, 0x16, 0x00, 0x00, 0x05, 0x65, 0x08, 0x02, 0x00, 0x00, 0x00, 0, 0, 0, 0]),
])
check('a PNG header gives 790 × 1381', [images.imageKindOf(png), images.imageDimensions(png, 'png')], ['png', { width: 790, height: 1381 }])
const jpeg = Buffer.concat([
  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.alloc(14, 0),
  Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x02, 0x1E, 0x02, 0xEE, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.from([0xFF, 0xDA, 0x00, 0x08, 0, 0, 0, 0, 0, 0]),
])
check('a JPEG frame header gives 750 × 542', [images.imageKindOf(jpeg), images.imageDimensions(jpeg, 'jpeg')], ['jpeg', { width: 750, height: 542 }])
check('a GIF header', images.imageDimensions(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00]), 'gif'), { width: 16, height: 32 })
check('text is not a picture', images.imageKindOf(Buffer.from('<html>')), null)
const kept = images.keepImage(png)
const keptAgain = images.keepImage(png)
check('a picture is kept under its hash, once', [kept.path === keptAgain.path, kept.path.startsWith(join(scratchDir, 'size-chart-images')), kept.kind, kept.width, kept.height, kept.bytes], [true, true, 'png', 790, 1381, png.length])
check('the kept bytes come back as a data URL for the page', images.imageDataUrl(kept.path)?.startsWith('data:image/png;base64,'), true)
let refused = ''
try {
  images.keepImage(Buffer.from('not a picture'))
}
catch (error) {
  refused = error instanceof Error ? error.message : String(error)
}
check('a non-picture is refused in plain words', refused, 'the link did not give a picture (not a JPEG, PNG, GIF or WebP)')
const fakeFetch = (async (url: string | URL | Request) => {
  const address = String(url)
  if (address.endsWith('404.jpg')) return new Response('gone', { status: 404, statusText: 'Not Found' })
  if (address.endsWith('html')) return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
  return new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } })
}) as typeof fetch
check('a fetched picture is kept and measured', await images.fetchImage('https://x/a.png', { fetch: fakeFetch }).then(r => [r.kind, r.width]), ['png', 790])
check('a 404 is reported as the link answering 404', await images.fetchImage('https://x/404.jpg', { fetch: fakeFetch }).catch(e => (e as Error).message), 'the link answered 404 Not Found')
check('a web page instead of a picture is reported', await images.fetchImage('https://x/page.html', { fetch: fakeFetch }).catch(e => (e as Error).message), 'the link did not give a picture (not a JPEG, PNG, GIF or WebP)')

// ---------------------------------------------------------------------------
section('Products: the 1688 id on a Shopify product')

check('a plain id', products.normaliseMetafieldSourceId('957039814706'), '957039814706')
check('a number-typed id', products.normaliseMetafieldSourceId('957039814706.0'), '957039814706')
check('an id inside a link metafield', products.normaliseMetafieldSourceId('{"text":"","url":"https://detail.1688.com/offer/957039814706.html"}'), '957039814706')
check('an empty metafield', products.normaliseMetafieldSourceId(''), null)
check('the page link out of a link metafield', products.sourceUrlFromMetafield('{"text":"","url":"https://detail.1688.com/offer/957039814706.html"}'), 'https://detail.1688.com/offer/957039814706.html')
check('a bare link is kept', products.sourceUrlFromMetafield('https://detail.1688.com/offer/1.html'), 'https://detail.1688.com/offer/1.html')
check('the product in the admin', store.adminProductUrl('tudoholic', 'gid://shopify/Product/8437'), 'https://admin.shopify.com/store/tudoholic/products/8437')
check('no shop, no admin link', store.adminProductUrl(null, 'gid://shopify/Product/8437'), null)

// ---------------------------------------------------------------------------
section('The table, on a scratch copy of the database')

const first = store.upsertSheetRows(parsed.rows, '2026-09-20 10:00:00')
check('first upload: every row added, one without a picture, two to fetch', first, { added: 3, changed: 0, unchanged: 3 - 3, noImage: 1, toFetch: ['957039814706', '681871315717'] })
const again = store.upsertSheetRows(parsed.rows, '2026-09-20 10:05:00')
check('the same sheet again changes nothing, and the unfetched pictures are still to fetch', again, { added: 0, changed: 0, unchanged: 3, noImage: 1, toFetch: ['957039814706', '681871315717'] })
check('counts by status', [store.countByStatus().queued, store.countByStatus()['no-image'], store.countByStatus().total, store.countByStatus().unmatched], [2, 1, 3, 3])

products.saveProductSources([
  { shopifyProductId: 'gid://shopify/Product/1', handle: 'mens-retro-denim-jacket', title: 'Men’s Retro Denim Jacket', productType: 'Trucker Jackets', status: 'ACTIVE', sourceProductId: '957039814706', sourceUrl: null, sizeOptions: JSON.stringify(['S', 'M', 'XL', 'XXL']) },
  { shopifyProductId: 'gid://shopify/Product/2', handle: 'womens-hoodie', title: 'Women’s Hoodie', productType: 'Hoodies', status: 'ACTIVE', sourceProductId: '681871315717', sourceUrl: null, sizeOptions: null },
  { shopifyProductId: 'gid://shopify/Product/3', handle: 'womens-hoodie-relisted', title: 'Women’s Hoodie (new listing)', productType: 'Hoodies', status: 'ACTIVE', sourceProductId: '681871315717', sourceUrl: null, sizeOptions: null },
], '2026-09-20 10:06:00')
check('two products may share one 1688 id', products.productsForSources(['681871315717']).get('681871315717')?.map(p => p.handle), ['womens-hoodie', 'womens-hoodie-relisted'])
check('the sneakers row has no product: unmatched', [store.countByStatus().unmatched, store.unmatchedSourceIds()], [1, ['959223261699']])
check('the product map stats', products.productSourceStats(), { products: 3, lastSyncedAt: '2026-09-20 10:06:00' })

const all = store.listCharts({ view: 'all', q: '', page: 1, size: 30, shopHandle: 'tudoholic' })
// Same upload time for all three, so the newest row (highest id) comes first.
check('all charts, newest change first, with their products', all.rows.map(r => [r.sourceProductId, r.status, r.products.map(p => p.title)]), [
  ['681871315717', 'queued', ['Women’s Hoodie', 'Women’s Hoodie (new listing)']],
  ['959223261699', 'no-image', []],
  ['957039814706', 'queued', ['Men’s Retro Denim Jacket']],
])
const rowFor = (sourceId: string) => all.rows.find(r => r.sourceProductId === sourceId)!
const jacketRow = rowFor('957039814706')
const sneakersRow = rowFor('959223261699')
const hoodieRow = rowFor('681871315717')
check('the default view (needs a look) is empty before anything is read', store.listCharts({ view: 'review', q: '', page: 1, size: 30, shopHandle: null }).total, 0)
check('the unmatched view', store.listCharts({ view: 'unmatched', q: '', page: 1, size: 30, shopHandle: null }).rows.map(r => r.sourceProductId), ['959223261699'])
check('search by product title', store.listCharts({ view: 'all', q: 'hoodie', page: 1, size: 30, shopHandle: null }).rows.map(r => r.sourceProductId), ['681871315717'])
check('search by 1688 id', store.listCharts({ view: 'all', q: '9592', page: 1, size: 30, shopHandle: null }).total, 1)
check('search by type', store.listCharts({ view: 'all', q: 'trucker', page: 1, size: 30, shopHandle: null }).total, 1)
check('paging: page 2 of size 2 holds the third row', store.listCharts({ view: 'all', q: '', page: 2, size: 2, shopHandle: null }).rows.length, 1)
check('the admin link uses the shop handle', jacketRow.products[0]!.adminUrl, 'https://admin.shopify.com/store/tudoholic/products/1')

store.markImageFetched(jacketRow.id, { sha256: kept.sha256, path: kept.path, bytes: kept.bytes, width: 790, height: 1381 }, '2026-09-20 10:07:00')
check('a fetched picture is no longer to fetch', store.upsertSheetRows(parsed.rows, '2026-09-20 10:08:00').toFetch, ['681871315717'])
const status = store.markRead(jacketRow.id, { read: jacket, chart: outcome.chart, flags: outcome.assessment.flags, notices: outcome.assessment.notices, confidence: outcome.assessment.confidence, autoApprove: outcome.assessment.autoApprove, model: 'claude-opus-5', tokensIn: 1500, tokensOut: 400 }, '2026-09-20 10:09:00')
check('a read with a flag needs a look', status, 'needs-review')
const reviewList = store.listCharts({ view: 'review', q: '', page: 1, size: 30, shopHandle: null })
check('it shows in the default view with its summary, flags and confidence', reviewList.rows.map(r => [r.summary, r.flags.length, r.confidence]), [['2 tables, 4 sizes (S to XXL)', 1, 0.85]])

check('approving without a chart is refused', store.approveChart(hoodieRow.id, 'shop', null), { ok: false, reason: 'This picture has not been read yet, so there is nothing to approve.' })
check('approving a read chart', store.approveChart(jacketRow.id, 'tudoholic.myshopify.com', 'checked against the picture', '2026-09-20 10:10:00'), { ok: true })
check('…moves it to approved with the reviewer\'s note', store.chartRowById(jacketRow.id, null)?.status === 'approved' && store.chartRowById(jacketRow.id, null)?.reviewNote === 'checked against the picture', true)
check('an auto-approved read is marked as the app\'s decision', store.markRead(hoodieRow.id, { read: clean, chart: cleanOutcome.chart, flags: [], notices: [], confidence: 1, autoApprove: true, model: 'claude-opus-5', tokensIn: 1, tokensOut: 1 }), 'approved')
check('…with reviewedBy app', store.chartById(hoodieRow.id)?.reviewedBy, 'app')
check('skipping', store.skipChart(hoodieRow.id, 'shop', 'the picture is a try-on report'), { ok: true })
check('requeue clears the read and keeps the picture', (() => {
  const r = store.requeueChart(jacketRow.id)
  const row = store.chartById(jacketRow.id)!
  return [r, row.status, row.chartJson, row.imagePath === kept.path]
})(), [{ ok: true }, 'queued', null, true])
check('requeue without a picture link is refused', store.requeueChart(sneakersRow.id), { ok: false, reason: 'The sheet has no picture link for this product, so there is nothing to read.' })
store.updateChart(jacketRow.id, { status: 'published' })
check('a published chart cannot be skipped or requeued', [store.skipChart(jacketRow.id, null, null).ok, store.requeueChart(jacketRow.id).ok], [false, false])

const changedRows = parsed.rows.map(row => row.sourceProductId === '957039814706' ? { ...row, imageUrl: 'https://cbu01.alicdn.com/img/ibank/new.jpg' } : row)
const third = store.upsertSheetRows(changedRows, '2026-09-20 10:20:00')
check('a new picture link queues the row again, even a published one', [third.changed, store.chartById(jacketRow.id)?.status, store.chartById(jacketRow.id)?.imagePath, store.chartById(jacketRow.id)?.chartJson], [1, 'queued', null, null])
check('…and the old Shopify publication is remembered for the next one to replace', store.chartById(jacketRow.id)?.publishedSha256 ?? 'kept', 'kept')

store.recordUpload({ fileName: 'Size chart 2026.xlsx', fileSha256: 'abc', uploadedBy: 'shop', rows: 3, added: 3, changed: 0, unchanged: 0, noImage: 1, skipped: 3, now: '2026-09-20 10:00:00' })
check('the upload is on record', [store.latestUpload()?.fileName, store.latestUpload()?.rows], ['Size chart 2026.xlsx', 3])

// ---------------------------------------------------------------------------
section('Jobs: one at a time, progress on the row')

let release: () => void = () => {}
const gate = new Promise<void>((resolve) => {
  release = resolve
})
const started = jobs.launchSizeChartJob('intake', 2, async (job) => {
  job.progress({ done: 1, note: 'half way' })
  await gate
  job.progress({ done: 2 })
})
check('a job starts and is running', [started.started, jobs.sizeChartJobById(started.jobId!)?.status, jobs.sizeChartJobById(started.jobId!)?.done, jobs.sizeChartJobById(started.jobId!)?.note], [true, 'running', 1, 'half way'])
const second = jobs.launchSizeChartJob('read', 1, async () => {})
check('a second job while one runs is refused with the running id', [second.started, second.alreadyRunning], [false, started.jobId])
release()
await new Promise(resolve => setTimeout(resolve, 20))
check('when the work ends the row says done, note cleared', [jobs.sizeChartJobById(started.jobId!)?.status, jobs.sizeChartJobById(started.jobId!)?.done, jobs.sizeChartJobById(started.jobId!)?.note], ['done', 2, null])
const crashed = jobs.launchSizeChartJob('publish', 1, async () => {
  throw new Error('Shopify said no')
})
await new Promise(resolve => setTimeout(resolve, 20))
check('a crash is written on the row', [jobs.sizeChartJobById(crashed.jobId!)?.status, jobs.sizeChartJobById(crashed.jobId!)?.error], ['failed', 'Shopify said no'])
check('the latest job is the crashed one', jobs.latestSizeChartJob()?.id, crashed.jobId)

// ---------------------------------------------------------------------------
section('The reader: what it is asked, what it is held to')

check('no key in the environment means no reader', reader.readerConfigFromEnv({}), null)
check('a key and the default model', reader.readerConfigFromEnv({ ANTHROPIC_API_KEY: ' sk-test ' }), { apiKey: 'sk-test', model: 'claude-opus-5' })
check('a model can be chosen in the environment', reader.readerConfigFromEnv({ ANTHROPIC_API_KEY: 'k', SIZE_CHART_READER_MODEL: 'claude-sonnet-5' })?.model, 'claude-sonnet-5')
const prompt = reader.buildReaderPrompt({ productTitle: 'Women’s Hoodie', productType: 'Hoodies', store: 'WOMENS' })
check('the prompt carries the word list, the one-row-per-size rule and the try-on rule', [
  prompt.system.includes('chest: 胸围 / 胸宽 (Chest)'),
  prompt.system.includes('turn it around: still one row per size'),
  prompt.system.includes('试穿报告'),
  prompt.system.includes('Never translate or convert a cell'),
], [true, true, true, true])
check('the product context is named', prompt.user, 'Product: Women’s Hoodie. Type: Hoodies. Sold as: women\'s.\n\nTranscribe the size chart in this picture.')
check('an odd answer is held to shape: unknown keys become other/unknown, missing bits empty', reader.toReadChart({
  isSizeChart: true,
  tables: [{ kind: 'weird', columns: [{ original: '胸围', measure: 'bosom', english: 'Bosom', unit: 'inches' }], rows: [{ size: 'M', cells: ['108', 5] }] }],
}), {
  isSizeChart: true,
  imageComplete: true,
  tables: [{ kind: 'other', titleOriginal: '', titleEnglish: '', sizeHeading: '', columns: [{ original: '胸围', measure: 'other', english: 'Bosom', unit: 'unknown' }], rows: [{ size: 'M', cells: ['108', '5'] }] }],
  notes: [],
  warnings: [],
})
let notChart = ''
try {
  reader.toReadChart('nonsense')
}
catch (error) {
  notChart = error instanceof Error ? error.message : String(error)
}
check('a non-object answer is refused', notChart, 'the reader answered with something that is not a chart')

const answerOf = (read: unknown, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  model: 'claude-opus-5-20260101',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1450, output_tokens: 380 },
  content: [{ type: 'text', text: JSON.stringify(read) }],
  ...extra,
}), { status: 200, headers: { 'content-type': 'application/json' } })
const calls: { url: string, headers: Record<string, string>, body: Record<string, unknown> }[] = []
const okFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) })
  return answerOf(clean)
}) as typeof fetch
const readInput = { image: png, mediaType: 'image/png', productTitle: 'Jacket', productType: 'Trucker Jackets', store: 'MENS' }
const readResult = await reader.readSizeChartImage(readInput, { apiKey: 'sk-test', model: 'claude-opus-5' }, { fetch: okFetch })
check('a good answer comes back as a transcript with the token counts', [readResult.read.tables.length, readResult.model, readResult.tokensIn, readResult.tokensOut], [1, 'claude-opus-5-20260101', 1450, 380])
check('the request goes to the Messages API with the key in the header, never in the body', [calls[0]!.url, calls[0]!.headers['x-api-key'], calls[0]!.headers['anthropic-version'], JSON.stringify(calls[0]!.body).includes('sk-test')], ['https://api.anthropic.com/v1/messages', 'sk-test', '2023-06-01', false])
check('the picture goes first, then the words; the answer is held to the schema', [
  (calls[0]!.body.messages as { content: { type: string }[] }[])[0]!.content.map(block => block.type),
  (calls[0]!.body.output_config as { format: { type: string } }).format.type,
  calls[0]!.body.model,
], [['image', 'text'], 'json_schema', 'claude-opus-5'])

const refusedKey = (async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })) as typeof fetch
check('a refused key is said in plain words', await reader.readSizeChartImage(readInput, { apiKey: 'bad', model: 'm' }, { fetch: refusedKey }).catch(e => (e as Error).message), 'the reading key was refused; check ANTHROPIC_API_KEY on the server')

let busyCalls = 0
const waits: number[] = []
const busyThenOk = (async () => {
  busyCalls++
  if (busyCalls < 3) return new Response('{}', { status: 529 })
  return answerOf(clean)
}) as typeof fetch
const recordWait = async (ms: number) => {
  waits.push(ms)
}
const afterBusy = await reader.readSizeChartImage(readInput, { apiKey: 'k', model: 'm' }, { fetch: busyThenOk, sleep: recordWait })
check('an overloaded reader is tried again after a pause, and the third answer is taken', [busyCalls, waits, afterBusy.read.isSizeChart], [3, [2000, 5000], true])

let alwaysBusy = 0
const neverOk = (async () => {
  alwaysBusy++
  return new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
}) as typeof fetch
check('four busy answers give up with a sentence', await reader.readSizeChartImage(readInput, { apiKey: 'k', model: 'm' }, { fetch: neverOk, sleep: async () => {} }).catch(e => (e as Error).message), 'the reader answered 429 (too many requests) three times; try again later')
check('…after exactly four tries', alwaysBusy, 4)

const badRequest = (async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'image exceeds 8000 pixels' } }), { status: 400 })) as typeof fetch
check('a bad request carries the reason', await reader.readSizeChartImage(readInput, { apiKey: 'k', model: 'm' }, { fetch: badRequest }).catch(e => (e as Error).message), 'the reader answered 400: image exceeds 8000 pixels')
const cutOff = (async () => answerOf(clean, { stop_reason: 'max_tokens' })) as typeof fetch
check('an answer cut short is refused', await reader.readSizeChartImage(readInput, { apiKey: 'k', model: 'm' }, { fetch: cutOff }).catch(e => (e as Error).message), 'the reader ran out of room before finishing the chart')
const notJson = (async () => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry, {' }] }), { status: 200 })) as typeof fetch
check('text that is not a chart is refused', await reader.readSizeChartImage(readInput, { apiKey: 'k', model: 'm' }, { fetch: notJson }).catch(e => (e as Error).message), 'the reader answered with text that is not a chart')
check('a picture too big for the reader is refused before any call', await reader.readSizeChartImage({ ...readInput, image: Buffer.alloc(8 * 1024 * 1024) }, { apiKey: 'k', model: 'm' }, { fetch: okFetch }).catch(e => (e as Error).message), 'the picture is 8 MB, more than the reader accepts')

// ---------------------------------------------------------------------------
section('The read job: every fetched picture, shared pictures once')

check('without a key the read job says why it did not start', jobs.startReadJob({}, { config: null }), { jobId: null, started: false, reason: 'The reading key is not set on the server (ANTHROPIC_API_KEY), so the pictures wait in the queue.' })

// Fresh rows for the job: two products sharing one picture, one with its own, one whose reading fails.
const jobRows = [
  { rowNumber: 1, sourceProductId: '700000000001', productType: 'Hoodies', store: 'MENS', imageUrl: 'https://x/shared.png', sourceUrl: null, remark: null },
  { rowNumber: 2, sourceProductId: '700000000002', productType: 'Hoodies', store: 'WOMENS', imageUrl: 'https://x/shared.png?__r__=2', sourceUrl: null, remark: null },
  { rowNumber: 3, sourceProductId: '700000000003', productType: 'T-Shirts', store: 'MENS', imageUrl: 'https://x/own.jpg', sourceUrl: null, remark: null },
  { rowNumber: 4, sourceProductId: '700000000004', productType: 'T-Shirts', store: 'MENS', imageUrl: 'https://x/broken.jpg', sourceUrl: null, remark: null },
]
store.upsertSheetRows(jobRows, '2026-09-20 11:00:00')
const jobRecords = store.chartsWithStatus(['queued'], jobRows.map(r => r.sourceProductId))
const sharedKept = images.keepImage(png)
const ownKept = images.keepImage(jpeg)
for (const record of jobRecords) {
  // 1 and 2 share the PNG; 3 has the JPEG the fake reader refuses; 4 shows
  // the PNG's bytes under a hash nobody else has, so it is read afresh.
  const kept = record.sourceProductId === '700000000003' ? ownKept : sharedKept
  store.markImageFetched(record.id, { sha256: record.sourceProductId === '700000000004' ? 'deadbeef' : kept.sha256, path: kept.path, bytes: kept.bytes, width: kept.width, height: kept.height }, '2026-09-20 11:01:00')
}
let readerCalls = 0
const fakeRead = async (input: { store?: string | null, image: Buffer }) => {
  readerCalls++
  if (input.image.equals(jpeg)) throw new Error('the reader declined to read this picture')
  return { read: clean, model: 'fake-reader', tokensIn: 100, tokensOut: 50 }
}
settings.setBooleanSetting(settings.SETTING_SIZE_CHARTS_AUTO_APPROVE, false)
const readJob = jobs.startReadJob({ sourceIds: jobRows.map(r => r.sourceProductId) }, { read: fakeRead, config: { apiKey: 'k', model: 'fake-reader' } })
check('the read job starts for the four fetched pictures', [readJob.started, jobs.sizeChartJobById(readJob.jobId!)?.total], [true, 4])
for (let waited = 0; waited < 50 && jobs.sizeChartJobById(readJob.jobId!)?.status === 'running'; waited++) await new Promise(resolve => setTimeout(resolve, 20))
const jobRow = jobs.sizeChartJobById(readJob.jobId!)!
check('it finishes: 4 handled, 1 failed', [jobRow.status, jobRow.done, jobRow.failed], ['done', 4, 1])
check('the shared picture was read once, the refused one once, the odd-hash one once: 3 reader calls', readerCalls, 3)
const after = new Map(store.chartsWithStatus(['needs-review', 'approved', 'read-failed', 'queued'], jobRows.map(r => r.sourceProductId)).map(r => [r.sourceProductId, r]))
check('with the switch off, a flawless chart still waits for a person', after.get('700000000001')?.status, 'needs-review')
check('the twin got the same transcript without a reader call, normalised for its own store (Bust)', [after.get('700000000002')?.status, after.get('700000000002')?.tokensIn, store.parseChart(after.get('700000000002')?.chartJson ?? null)?.tables[0]?.columns[1]?.label], ['needs-review', 0, 'Bust'])
check('the first of the pair reads Chest', store.parseChart(after.get('700000000001')?.chartJson ?? null)?.tables[0]?.columns[1]?.label, 'Chest')
check('a reading the reader declined is written on the row', [after.get('700000000003')?.status, after.get('700000000003')?.error], ['read-failed', 'the reader declined to read this picture'])
check('the row whose picture hash matches nothing was read fresh and kept', after.get('700000000004')?.status, 'needs-review')

settings.setBooleanSetting(settings.SETTING_SIZE_CHARTS_AUTO_APPROVE, true)
store.requeueChart(after.get('700000000001')!.id)
const again2 = jobs.startReadJob({ sourceIds: ['700000000001'] }, { read: fakeRead, config: { apiKey: 'k', model: 'fake-reader' } })
for (let waited = 0; waited < 50 && jobs.sizeChartJobById(again2.jobId!)?.status === 'running'; waited++) await new Promise(resolve => setTimeout(resolve, 20))
check('with the switch on, a flawless chart is approved by the app', [store.chartById(after.get('700000000001')!.id)?.status, store.chartById(after.get('700000000001')!.id)?.reviewedBy], ['approved', 'app'])
check('re-reading a picture its twin already holds costs no reader call', readerCalls, 3)
check('nothing left to read: the job says so instead of starting', jobs.startReadJob({ sourceIds: ['700000000001'] }, { read: fakeRead, config: { apiKey: 'k', model: 'm' } }).reason, 'No fetched pictures are waiting to be read.')
settings.setBooleanSetting(settings.SETTING_SIZE_CHARTS_AUTO_APPROVE, false)

let followed = 0
const chained = jobs.launchSizeChartJob('intake', 0, async () => {}, () => {
  followed++
})
for (let waited = 0; waited < 50 && jobs.sizeChartJobById(chained.jobId!)?.status === 'running'; waited++) await new Promise(resolve => setTimeout(resolve, 10))
await new Promise(resolve => setTimeout(resolve, 10))
check('a follow-up runs once the job has finished', followed, 1)
let followedAfterCrash = 0
const crashedChain = jobs.launchSizeChartJob('intake', 0, async () => {
  throw new Error('no')
}, () => {
  followedAfterCrash++
})
for (let waited = 0; waited < 50 && jobs.sizeChartJobById(crashedChain.jobId!)?.status === 'running'; waited++) await new Promise(resolve => setTimeout(resolve, 10))
await new Promise(resolve => setTimeout(resolve, 10))
check('no follow-up after a crash', followedAfterCrash, 0)

writeFileSync(join(scratchDir, 'chart.svg'), svg)

// ---------------------------------------------------------------------------
section('No size chart route answers without a Shopify login')

// 2026-09-23: summary, list, one chart and job progress looked the shop up
// but carried on without one, and logistics.tudoholic.com gave anyone on the
// internet 100 charts, the 77,230-product map and the 1688 supplier links.
{
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
  const routes = walk(join(repo, 'server/api/size-charts')).filter(path => path.endsWith('.ts'))
  const open = routes.filter((path) => {
    const code = readFileSync(path, 'utf8')
    return !/statusCode: 401/.test(code) && !/getAccessToken\(event\)/.test(code)
  }).map(path => path.slice(repo.length))
  check(`every one of the ${routes.length} routes refuses a request with no login`, open, [])
  const swallowed = routes.filter((path) => {
    const code = readFileSync(path, 'utf8')
    const guard = code.indexOf('statusCode: 401')
    const tryAt = code.indexOf('try {')
    const rethrows = /'statusCode' in error\) throw error/.test(code)
    return guard > tryAt && tryAt !== -1 && !rethrows && !/getAccessToken\(event\)/.test(code)
  }).map(path => path.slice(repo.length))
  check('  and no route catches its own refusal and answers 200 instead', swallowed, [])
}

rmSync(scratchDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nAll size chart checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

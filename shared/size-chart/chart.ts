/**
 * From what the reader saw to what the customer sees.
 *
 * Two shapes live here. `ReadChart` is the reader's transcript of the
 * supplier's picture — headings as printed, cells as printed, each heading
 * named from the word list — and `READ_CHART_SCHEMA` is the JSON schema the
 * model is held to. `PublishedChart` is the finished article: English
 * headings, every figure in metric and imperial, ready for the storefront
 * block, the PNG and the review page, which all print it and never compute.
 *
 * `normaliseChart` walks from one to the other and, on the way, writes down
 * every reason a person should look before it goes live.
 */

import { isMeasureKey, MEASURE_KEYS, MEASURES, measureFromHeading, measureLabel } from './glossary'
import type { MeasureKey, UnitFamily } from './glossary'
import { DEFAULT_INCH_ROUNDING, formatValue, parseCell, SOURCE_UNITS, unitLabel } from './values'
import type { ChartValue, InchRounding, SourceUnit } from './values'

export type TableKind = 'garment' | 'fit' | 'shoe' | 'other'

export interface ReadColumn {
  /** The heading as printed, e.g. 胸围. */
  original: string
  /** A key from the word list, or `other`. */
  measure: MeasureKey | 'other'
  /** The reader's own translation — used only when `measure` is `other`. */
  english: string
  /** The unit the column is in, as printed on the heading or a footnote, or implied. */
  unit: SourceUnit
}

export interface ReadRow {
  size: string
  /** One entry per column, exactly as printed ("1尺7-1尺9", "80-100斤", ""). */
  cells: string[]
}

export interface ReadTable {
  kind: TableKind
  titleOriginal: string
  titleEnglish: string
  sizeHeading: string
  columns: ReadColumn[]
  rows: ReadRow[]
}

export interface ReadChart {
  isSizeChart: boolean
  imageComplete: boolean
  tables: ReadTable[]
  /** Supplier notes worth keeping, translated ("Measured flat by hand; allow 1-3 cm"). */
  notes: string[]
  /** Anything a reviewer must know: unclear handwriting, a suspected typo, a unit that was guessed. */
  warnings: string[]
}

/** The JSON schema the reader is held to (structured output: every object closed, every field required). */
export const READ_CHART_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isSizeChart', 'imageComplete', 'tables', 'notes', 'warnings'],
  properties: {
    isSizeChart: { type: 'boolean', description: 'true when the picture contains at least one table of sizes with measurements or fit recommendations; false for a try-on report alone, a colour display, or a picture with no table' },
    imageComplete: { type: 'boolean', description: 'false when a table is visibly cut off at an edge of the picture' },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'titleOriginal', 'titleEnglish', 'sizeHeading', 'columns', 'rows'],
        properties: {
          kind: { type: 'string', enum: ['garment', 'fit', 'shoe', 'other'], description: 'garment: measurements of the item; fit: recommended body height/weight per size; shoe: shoe sizes with foot or insole length; other: anything else worth keeping' },
          titleOriginal: { type: 'string', description: 'the table title as printed, or empty' },
          titleEnglish: { type: 'string', description: 'the title in plain English, or empty' },
          sizeHeading: { type: 'string', description: 'the heading of the size column as printed, e.g. 尺码' },
          columns: {
            type: 'array',
            description: 'every column except the size column, left to right',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['original', 'measure', 'english', 'unit'],
              properties: {
                original: { type: 'string', description: 'the heading exactly as printed' },
                measure: { type: 'string', enum: [...MEASURE_KEYS, 'other'], description: 'the word-list key that means the same as the heading, or other' },
                english: { type: 'string', description: 'your English for the heading; used only when measure is other' },
                unit: { type: 'string', enum: [...SOURCE_UNITS], description: 'the unit the column is in as printed on the heading, a footnote or the cells; chi for 尺, jin for 斤; none for size codes; unknown when nothing says' },
              },
            },
          },
          rows: {
            type: 'array',
            description: 'one per size, top to bottom',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['size', 'cells'],
              properties: {
                size: { type: 'string', description: 'the size label exactly as printed, e.g. M, 2XL, 39, 均码' },
                cells: { type: 'array', items: { type: 'string' }, description: 'one per column, exactly as printed, empty string for an empty cell' },
              },
            },
          },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const

export interface PublishedColumn {
  label: string
  /** Unit printed under the heading in each system; null for a unitless column (a size code). */
  metric: string | null
  imperial: string | null
}

export interface PublishedRow {
  size: string
  metric: string[]
  imperial: string[]
}

export interface PublishedTable {
  title: string
  /** The first column is always Size. */
  columns: PublishedColumn[]
  rows: PublishedRow[]
}

export interface PublishedChart {
  v: 1
  tables: PublishedTable[]
  notes: string[]
}

export interface Assessment {
  /** Plain sentences, one per reason a person should look. Empty means nothing stood out. */
  flags: string[]
  /** What the app changed on purpose, for the reviewer to see. Never a doubt, never a cost to confidence. */
  notices: string[]
  /** 1 with no flags, falling by 0.15 per flag, 0 when the picture is not a chart. */
  confidence: number
  /** True only when nothing at all stood out and a table was kept. */
  autoApprove: boolean
}

export interface NormaliseOptions {
  /** MENS or WOMENS — decides Chest vs Bust. */
  store?: string | null
  inchRounding?: InchRounding
  /**
   * The sizes the shop actually sells this product in (Shopify's Size
   * option). The first column of the chart has to be the one a customer can
   * pick, so this decides which column that is — and what the chart is
   * missing.
   */
  sizesSold?: readonly string[]
}

const X_SIZES: Record<string, string> = { xxl: '2xl', xxxl: '3xl', xxxxl: '4xl', xxxxxl: '5xl', xxs: '2xs', 均码: 'onesize', freesize: 'onesize', onesizefitsall: 'onesize' }

/**
 * One size, however it was written, as a key two spellings share.
 *
 * "38.0" and "38"; " M " and "m"; "XXL" and "2XL"; and the shop's own
 * "S (recommended below 47.5kg)" or "XS（90~105）" and the chart's "S" —
 * anything in brackets, and a weight or height note after the code, is not
 * part of the size.
 */
export function sizeKey(value: string): string {
  let text = value.toLowerCase()
    .replace(/[（([【][^）)\]】]*[）)\]】]?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const code = /^(\d*x{0,5}[sml]|\d+(?:\.\d+)?|均码|one size)(?=$|[\s,])/.exec(text)
  if (code) text = code[1]!
  text = text.replace(/\s+/g, '')
  if (/^\d+(\.\d+)?$/.test(text)) return String(Number(text))
  return X_SIZES[text] ?? text
}

/** The unit a printed heading declares, for the size column the reader does not describe. */
function unitFromHeading(heading: string): SourceUnit {
  const text = heading.replace(/\s+/g, '')
  if (/公斤|千克|kg/i.test(text)) return 'kg'
  if (/斤/.test(text)) return 'jin'
  if (/尺|寸/.test(text)) return 'chi'
  if (/厘米|公分|cm/i.test(text)) return 'cm'
  if (/毫米|mm/i.test(text)) return 'mm'
  if (/英寸|inch/i.test(text)) return 'inch'
  return 'unknown'
}

/** Size codes a shoe chart may be keyed on, best first, when the shop's own sizes are unknown. */
const CODE_PREFERENCE: readonly MeasureKey[] = ['standardSize', 'eu', 'cnOld', 'us', 'uk', 'cn', 'intlSize', 'jp', 'kr']

/**
 * A size column of 215, 220, 225 is the supplier's millimetre code, which no
 * customer picks from a drop-down. Nothing anybody wears is numbered in the
 * hundreds, so a column of three-figure numbers is a measurement in disguise.
 */
function looksLikeMillimetres(values: readonly string[]): boolean {
  const numbers = values.map(value => Number(value.replace(/\s+/g, ''))).filter(value => Number.isFinite(value))
  return numbers.length === values.length && numbers.length > 0 && numbers.every(value => value >= 100)
}

function columnFamily(column: ReadColumn): UnitFamily {
  if (column.measure !== 'other' && isMeasureKey(column.measure)) return MEASURES[column.measure].family
  return 'text'
}

function allDistinct(values: readonly string[]): boolean {
  const seen = new Set(values.map(sizeKey))
  return seen.size === values.length && !values.some(value => value.trim() === '')
}

/**
 * Make sure the first column is the size a customer can actually pick.
 *
 * Suppliers print shoe charts sideways: foot length along the top, size codes
 * below it. Turned around (the reader does that), the first column becomes
 * "22.0, 22.5, 23.0" — centimetres, which no one can choose from a drop-down,
 * while the sizes the shop sells sit in a column further right. This swaps
 * them: the size column becomes the code that matches what the shop sells,
 * and the foot length becomes an ordinary measurement, converted like any
 * other. Returns the table unchanged when the size column is already right.
 */
export function pivotToSoldSizes(table: ReadTable, sizesSold: readonly string[] = []): { table: ReadTable, note: string | null } {
  if (table.rows.length === 0 || table.columns.length === 0) return { table, note: null }
  const sold = new Set(sizesSold.map(sizeKey))
  const currentSizes = table.rows.map(row => row.size)
  // With the shop's own sizes in hand, ANY column may turn out to be the size
  // column — the supplier's heading for it ("标准码") need not be one the word
  // list knows. A measurement column cannot win by accident: centimetres
  // never match the sizes a shop sells.
  const candidates = table.columns
    .map((column, index) => ({ column, index }))
    .filter(entry => sold.size > 0 || columnFamily(entry.column) === 'count')
  if (candidates.length === 0) return { table, note: null }
  const codeIndexes = candidates

  const valuesAt = (index: number) => table.rows.map(row => (row.cells[index] ?? '').trim())
  let chosen: number | null = null

  if (sold.size > 0) {
    // How many DIFFERENT sizes on sale a column covers: a column that repeats
    // itself (EU 37, 37, 40, 40) matches many cells but names few sizes.
    const score = (values: readonly string[]) => new Set(values.map(sizeKey).filter(key => sold.has(key))).size
    const currentScore = score(currentSizes)
    let bestScore = currentScore
    for (const entry of codeIndexes) {
      const entryScore = score(valuesAt(entry.index))
      if (entryScore > bestScore) {
        bestScore = entryScore
        chosen = entry.index
      }
    }
  }
  else {
    // Nothing known about what the shop sells: only step in when the size
    // column is plainly not a size — a measurement, or the millimetre code.
    const headingMeasure = measureFromHeading(table.sizeHeading)
    const headingIsLength = headingMeasure !== null && MEASURES[headingMeasure].family === 'length'
    if (!headingIsLength && !looksLikeMillimetres(currentSizes)) return { table, note: null }
    for (const preferred of CODE_PREFERENCE) {
      const entry = codeIndexes.find(candidate => candidate.column.measure === preferred)
      if (entry && allDistinct(valuesAt(entry.index))) {
        chosen = entry.index
        break
      }
    }
    if (chosen === null) {
      const entry = codeIndexes.find(candidate => allDistinct(valuesAt(candidate.index)))
      chosen = entry ? entry.index : null
    }
  }

  if (chosen === null) return { table, note: null }

  const movedIn = table.columns[chosen]!
  const headingMeasure = measureFromHeading(table.sizeHeading)
  const movedOut: ReadColumn = {
    original: table.sizeHeading,
    measure: headingMeasure ?? 'other',
    english: headingMeasure ? MEASURES[headingMeasure].label : table.sizeHeading,
    unit: unitFromHeading(table.sizeHeading),
  }
  const keptIndexes = table.columns.map((_, index) => index).filter(index => index !== chosen)
  const rebuilt: ReadTable = {
    ...table,
    sizeHeading: movedIn.original,
    columns: [movedOut, ...keptIndexes.map(index => table.columns[index]!)],
    rows: table.rows.map(row => ({
      size: (row.cells[chosen!] ?? '').trim(),
      cells: [row.size, ...keptIndexes.map(index => row.cells[index] ?? '')],
    })),
  }
  const movedOutLabel = (headingMeasure ? MEASURES[headingMeasure].label.toLowerCase() : table.sizeHeading) || 'a measurement'
  const because = sold.size > 0 ? ', which is what the shop sells' : ''
  return {
    table: rebuilt,
    note: `The sizes now come from "${movedIn.original}"${because}, not from ${movedOutLabel}; ${movedOutLabel} is a column like the others.`,
  }
}

const CELL_FLAG_CAP = 6

function tableTitle(table: ReadTable): string {
  const english = table.titleEnglish.trim()
  switch (table.kind) {
    case 'garment': return 'Measurements'
    case 'fit': return 'Recommended height and weight'
    case 'shoe': return 'Shoe sizes'
    default: return english !== '' ? english : 'Details'
  }
}

function familyForOther(unit: SourceUnit): UnitFamily {
  if (unit === 'cm' || unit === 'mm' || unit === 'inch' || unit === 'chi') return 'length'
  if (unit === 'jin' || unit === 'kg') return 'weight'
  if (unit === 'g') return 'garmentWeight'
  return 'text'
}

function tidyLabel(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return ''
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function isNumeric(value: ChartValue): value is Extract<ChartValue, { kind: 'number' }> {
  return value.kind === 'number'
}

/** Sizes a chart covers, in the order printed, once each. */
const UNIT_WORD = String.raw`(?:mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|inch(?:es)?|kg|kilo(?:gram)?s?|grams?|jin|catties|chi|met(?:er|re)s?)\b`
const UNIT_STATEMENTS = [
  // "Unit: cm", "The unit of measurement is millimetres"
  new RegExp(String.raw`\bunits?\b[^.;]*?\b${UNIT_WORD}`, 'i'),
  // "All measurements above are in millimetres", "The data in the table is measured in cm"
  new RegExp(String.raw`\b(?:measurements?|data|figures|numbers|values|dimensions|sizes|lengths?|weights?|heights?)\b(?:\s+[\w-]+){0,4}?\s+(?:are|is|were|was)\s+(?:(?:all|given|shown|listed|measured|stated|expressed|recorded|taken)\s+)?in\s+${UNIT_WORD}`, 'i'),
  // "Measurements in cm.", "In cm"
  new RegExp(String.raw`^(?:(?:all\s+)?(?:the\s+)?(?:measurements?|data|sizes|dimensions|figures)\s+)?(?:are\s+)?in\s+${UNIT_WORD}\.?$`, 'i'),
]

/**
 * A supplier note that only says which unit the table is in ("All
 * measurements above are in millimetres", "Unit: cm"). The app converts
 * every figure and labels its own units, so on the website such a note is
 * wrong: the table shows inches or centimetres. A note with a number in it
 * is advice ("allow 1-3 cm") and is kept.
 */
export function isUnitStatement(note: string): boolean {
  return !/\d/.test(note) && UNIT_STATEMENTS.some(pattern => pattern.test(note))
}

/** The supplier notes a customer should see: every note but a statement of units. */
export function customerNotes(notes: readonly string[]): string[] {
  return notes.filter(note => !isUnitStatement(note))
}

export function sizesOf(chart: PublishedChart): string[] {
  const seen = new Set<string>()
  for (const table of chart.tables) {
    for (const row of table.rows) seen.add(row.size)
  }
  return [...seen]
}

/** "2 tables, 7 sizes (S to XXXXL)" — for a list row. */
export function chartSummary(chart: PublishedChart): string {
  const sizes = sizesOf(chart)
  const tables = chart.tables.length
  const tablesWords = `${tables} ${tables === 1 ? 'table' : 'tables'}`
  if (sizes.length === 0) return tablesWords
  const span = sizes.length === 1 ? sizes[0]! : `${sizes[0]} to ${sizes[sizes.length - 1]}`
  return `${tablesWords}, ${sizes.length} ${sizes.length === 1 ? 'size' : 'sizes'} (${span})`
}

export function normaliseChart(read: ReadChart, options: NormaliseOptions = {}): { chart: PublishedChart, assessment: Assessment } {
  const rounding = options.inchRounding ?? DEFAULT_INCH_ROUNDING
  const flags: string[] = []
  const cellFlags: string[] = []
  // Things the app did on purpose and a reviewer should know about, but which
  // are not doubts: they are shown beside the chart without costing confidence.
  const notices: string[] = []

  if (!read.isSizeChart) flags.push('The picture is not a size chart, or no table of sizes could be found in it.')
  if (!read.imageComplete) flags.push('The picture looks cut off; part of a table may be missing.')
  for (const warning of read.warnings) {
    const text = warning.trim()
    if (text !== '') flags.push(`The reader noted: ${text}`)
  }

  const tables: PublishedTable[] = []
  for (const source of read.tables) {
    const title = tableTitle(source)
    if (source.rows.length === 0) {
      flags.push(`The table "${title}" has no rows.`)
      continue
    }
    const pivoted = pivotToSoldSizes(source, options.sizesSold)
    const table = pivoted.table
    if (pivoted.note) notices.push(pivoted.note)

    const columns = table.columns.map((column) => {
      const known = column.measure !== 'other' && isMeasureKey(column.measure)
      const family: UnitFamily = known ? MEASURES[column.measure as MeasureKey].family : familyForOther(column.unit)
      const label = known
        ? measureLabel(column.measure as MeasureKey, options.store)
        : (tidyLabel(column.english) || column.original.trim() || 'Column')
      if (!known) flags.push(`The column "${column.original.trim() || label}" (${label}) is not in the app's word list; check its heading.`)
      return { label, family, unit: column.unit }
    })

    const assumedNoted = new Set<number>()
    const previous: (number | null)[] = columns.map(() => null)
    const seenSizes = new Set<string>()
    const rows: PublishedRow[] = []
    for (const row of table.rows) {
      const size = row.size.replace(/\s+/g, ' ').trim()
      if (seenSizes.has(size)) flags.push(`The size "${size}" appears twice in "${title}".`)
      seenSizes.add(size)
      if (row.cells.length > columns.length) flags.push(`The row for size "${size}" in "${title}" has more cells than headings.`)

      const metric: string[] = []
      const imperial: string[] = []
      columns.forEach((column, index) => {
        const raw = row.cells[index] ?? ''
        const parsed = parseCell(raw, column.family, column.unit)
        const value = parsed.value
        if (parsed.assumed && !assumedNoted.has(index)) {
          assumedNoted.add(index)
          flags.push(`${column.label}: ${parsed.assumed}.`)
        }
        if (value.kind === 'text' && column.family !== 'text') {
          cellFlags.push(`"${raw.trim()}" under ${column.label} (size ${size}) could not be read as a number.`)
        }
        if ((table.kind === 'garment' || table.kind === 'shoe') && (column.family === 'length' || column.family === 'count') && isNumeric(value)) {
          // Missing (first size in the column) reads as no previous value.
          const before = previous[index] ?? null
          if (before !== null && before > 0 && value.value < before * 0.85) {
            flags.push(`${column.label}: ${before} then ${value.value} for size ${size} looks like a typo in the supplier's table.`)
          }
          previous[index] = value.value
        }
        metric.push(formatValue(value, column.family, 'metric', rounding))
        imperial.push(formatValue(value, column.family, 'imperial', rounding))
      })
      rows.push({ size, metric, imperial })
    }

    tables.push({
      title,
      columns: [
        { label: 'Size', metric: null, imperial: null },
        ...columns.map(column => ({
          label: column.label,
          metric: unitLabel(column.family, 'metric'),
          imperial: unitLabel(column.family, 'imperial'),
        })),
      ],
      rows,
    })
  }

  if (cellFlags.length > CELL_FLAG_CAP) {
    flags.push(...cellFlags.slice(0, CELL_FLAG_CAP), `…and ${cellFlags.length - CELL_FLAG_CAP} more cells that could not be read as numbers.`)
  }
  else {
    flags.push(...cellFlags)
  }
  if (read.isSizeChart && tables.length === 0) flags.push('No table could be kept from the picture.')

  // A chart that does not cover a size on sale sends that customer away, so
  // it is the one mismatch worth stopping for.
  const sold = options.sizesSold ?? []
  if (sold.length > 0 && tables.length > 0) {
    const covered = new Set(tables.flatMap(table => table.rows.map(row => sizeKey(row.size))))
    const missing = sold.filter(size => !covered.has(sizeKey(size)))
    if (missing.length === sold.length) {
      flags.push(`This chart shows none of the sizes the shop sells (${sold.slice(0, 8).join(', ')}${sold.length > 8 ? ', …' : ''}); it may belong to another product.`)
    }
    else if (missing.length > 0) {
      flags.push(`The shop sells ${missing.length === 1 ? 'size' : 'sizes'} ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''} that this chart does not show.`)
    }
  }

  const notes = customerNotes(read.notes.map(note => note.replace(/\s+/g, ' ').trim()).filter(note => note !== '')).slice(0, 5)
  const confidence = read.isSizeChart ? Math.max(0, Math.round((1 - 0.15 * flags.length) * 100) / 100) : 0

  return {
    chart: { v: 1, tables, notes },
    assessment: { flags, notices, confidence, autoApprove: flags.length === 0 && tables.length > 0 },
  }
}

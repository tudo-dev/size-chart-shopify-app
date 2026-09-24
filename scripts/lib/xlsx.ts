/**
 * Reads .xlsx workbooks with nothing but Node's own zlib.
 *
 * The carrier data we have to ingest arrives as spreadsheets — the owner's
 * geography workbook, Hulagi's order export, the performance grid. Pulling in a
 * spreadsheet library for that would add a dependency to the app itself, so this
 * reads the format directly. An .xlsx is a zip of XML files, and both halves of
 * that are small enough to do by hand.
 *
 * What it deliberately does *not* do: formulas (the cached result is returned,
 * which is what a value read wants anyway), styles beyond spotting which cells
 * are dates, charts, pivot tables, or writing. Anything it cannot read, it
 * throws about rather than returning a plausible-looking wrong answer — a
 * silently mis-parsed price or delivery date is far more expensive here than a
 * failed import.
 *
 * Every cell comes back as a string, the way a CSV export would give it. Numbers
 * keep full precision (`String(n)`, never a locale format), so `Number(cell)` is
 * exact for rates. Date-styled cells come back ISO so they sort and compare as
 * text. That keeps the importers on one code path whether their source was a
 * spreadsheet or a CSV.
 *
 * Two real-world variations these files actually contain, both handled:
 * every element may carry a namespace prefix (`<x:sheet>` — Hulagi's export
 * does this and Excel's does not), and plain text may arrive as `t="str"`
 * rather than a shared-string index.
 */

import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/* ------------------------------------------------------------------------- *
 * Zip container
 * ------------------------------------------------------------------------- */

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** The end-of-central-directory record, which is the only fixed landmark. */
function findEndOfCentralDirectory(buf: Buffer): number {
  // It sits at the very end unless there is a trailing comment, which is
  // capped at 65535 bytes. Scan back over that window, not the whole file.
  const earliest = Math.max(0, buf.length - 22 - 0xffff)
  for (let at = buf.length - 22; at >= earliest; at--) {
    if (buf.readUInt32LE(at) === SIG_EOCD) return at
  }
  throw new Error('not a zip file: no end-of-central-directory record')
}

interface ZipEntry {
  name: string
  /** Offset of this entry's local header. */
  localHeaderOffset: number
  compressionMethod: number
  compressedSize: number
}

function readZipEntries(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEndOfCentralDirectory(buf)
  const entryCount = buf.readUInt16LE(eocd + 10)
  const centralDirOffset = buf.readUInt32LE(eocd + 16)

  // Zip64 uses these sentinels and puts the real values in a separate record.
  // No workbook we ingest is anywhere near 4 GB or 65535 entries, so rather
  // than implement it, say so plainly.
  if (entryCount === 0xffff || centralDirOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported')
  }

  const entries = new Map<string, ZipEntry>()
  let at = centralDirOffset
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(at) !== SIG_CENTRAL) {
      throw new Error(`corrupt zip: bad central directory header at byte ${at}`)
    }
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength)
    entries.set(name, {
      name,
      compressionMethod: buf.readUInt16LE(at + 10),
      compressedSize: buf.readUInt32LE(at + 20),
      localHeaderOffset: buf.readUInt32LE(at + 42),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntry(buf: Buffer, entry: ZipEntry): string {
  const at = entry.localHeaderOffset
  if (buf.readUInt32LE(at) !== SIG_LOCAL) {
    throw new Error(`corrupt zip: bad local header for ${entry.name}`)
  }
  // The local header repeats the name and extra field, and its *extra* length
  // can differ from the central directory's. Read the local one.
  const nameLength = buf.readUInt16LE(at + 26)
  const extraLength = buf.readUInt16LE(at + 28)
  const dataStart = at + 30 + nameLength + extraLength
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.compressionMethod === 0) return data.toString('utf8')
  if (entry.compressionMethod === 8) return inflateRawSync(data).toString('utf8')
  throw new Error(`unsupported compression method ${entry.compressionMethod} for ${entry.name}`)
}

/* ------------------------------------------------------------------------- *
 * XML
 * ------------------------------------------------------------------------- */

/**
 * An optional namespace prefix on an element name.
 *
 * Excel writes `<sheet>`; the tool that produced Hulagi's export writes
 * `<x:sheet>`. Both are correct, so every element pattern allows either. It is
 * kept loose on purpose — matching the *declared* prefix would mean tracking
 * xmlns scopes to read a spreadsheet, and no plausible workbook has an element
 * whose name only differs by prefix.
 */
const NS = '(?:[A-Za-z_][A-Za-z0-9_.-]*:)?'

/** A `g`-flagged pattern for one element, open-and-close or self-closing. */
function elementPattern(name: string): RegExp {
  return new RegExp(`<${NS}${name}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}${name}>)`, 'g')
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'',
}

/** Turns `&amp;`, `&#39;` and `&#x27;` back into characters. */
function decodeXmlText(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body] ?? whole
  })
}

/** Reads one attribute off an opening tag, e.g. `r` from `<c r="A1" t="s">`. */
function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`\\s${escaped}\\s*=\\s*"([^"]*)"`).exec(tag)
    ?? new RegExp(`\\s${escaped}\\s*=\\s*'([^']*)'`).exec(tag)
  return match ? decodeXmlText(match[1]!) : undefined
}

/**
 * Every `<t>` run inside one element, concatenated.
 *
 * A shared string can be a single `<t>` or a series of `<r><t>` runs when part
 * of the text was formatted differently — "Kathmandu **Valley**" is two runs and
 * one string. Phonetic hints (`<rPh>`) also contain `<t>` and are not part of
 * the value, so they come out first.
 */
function textRuns(xml: string): string {
  const withoutPhonetics = xml.replace(new RegExp(`<${NS}rPh\\b[\\s\\S]*?<\\/${NS}rPh>`, 'g'), '')
  let out = ''
  const run = elementPattern('t')
  let match: RegExpExecArray | null
  while ((match = run.exec(withoutPhonetics)) !== null) {
    out += decodeXmlText(match[2] ?? '')
  }
  return out
}

/* ------------------------------------------------------------------------- *
 * Dates
 * ------------------------------------------------------------------------- */

/**
 * Number formats Excel ships with that mean "this is a date or a time".
 *
 * A date cell holds a plain number; only its format says it is a date. These
 * are the built-in format ids reserved for dates and times by the spec.
 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/** True if a custom format code describes a date or time rather than a number. */
function formatCodeIsDate(code: string): boolean {
  // Strip literals and colour/condition sections so their letters cannot be
  // mistaken for date tokens — `"May"` or `[Red]` are not date placeholders.
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
  return /[ymdhs]/i.test(bare)
}

/**
 * Converts a date serial to ISO text.
 *
 * Excel's 1900 system pretends 1900 was a leap year, so every serial from 61
 * onward is one day further from the true epoch than it looks. Anchoring at
 * 1899-12-30 absorbs that, which is correct for every date after 1900-02-28 —
 * which is every date in any carrier export. Serials below 61 fall in the
 * distorted region and are not worth guessing at, so they are refused.
 */
function serialToIso(serial: number, use1904: boolean): string {
  const epochUtc = use1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  if (!use1904 && serial > 0 && serial < 61) {
    throw new Error(
      `date serial ${serial} falls in Excel's distorted 1900 window and cannot be read reliably`,
    )
  }

  const wholeDays = Math.floor(serial)
  const fractionOfDay = serial - wholeDays
  // Round to the second. Serials are binary fractions of a day, so a stored
  // 09:39:58 arrives as 09:39:57.9999999 and must not truncate to :57.
  const secondsIntoDay = Math.round(fractionOfDay * 86400)

  const at = new Date(epochUtc + wholeDays * 86_400_000 + secondsIntoDay * 1000)
  const iso = at.toISOString()
  // A midnight cell is a date, not an instant; do not invent a time on it.
  return secondsIntoDay === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
}

/* ------------------------------------------------------------------------- *
 * Cell addresses
 * ------------------------------------------------------------------------- */

/** `A1` → 0, `Z9` → 25, `AA1` → 26. */
function columnIndexOf(cellReference: string): number {
  let index = 0
  for (const character of cellReference) {
    const code = character.charCodeAt(0)
    if (code < 65 || code > 90) break // hit the row number
    index = index * 26 + (code - 64)
  }
  if (index === 0) throw new Error(`cannot read a column from cell reference "${cellReference}"`)
  return index - 1
}

/* ------------------------------------------------------------------------- *
 * Workbook
 * ------------------------------------------------------------------------- */

export interface XlsxSheet {
  name: string
  /**
   * Rows of cells, every cell a string. Empty and missing cells are `''`, so a
   * row is dense up to its last populated cell but rows are not padded to a
   * common width — read by index as `row[i] ?? ''`.
   */
  rows: string[][]
}

interface WorkbookParts {
  sharedStrings: string[]
  /** cell style index → true when that style means "date". */
  styleIsDate: boolean[]
  use1904: boolean
}

function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return []
  const out: string[] = []
  const item = elementPattern('si')
  let match: RegExpExecArray | null
  while ((match = item.exec(xml)) !== null) {
    out.push(match[2] === undefined ? '' : textRuns(match[2]))
  }
  return out
}

function readStyles(xml: string | undefined): boolean[] {
  if (!xml) return []

  // Custom formats first: id → whether the code describes a date.
  const customIsDate = new Map<number, boolean>()
  const numFmt = elementPattern('numFmt')
  let match: RegExpExecArray | null
  while ((match = numFmt.exec(xml)) !== null) {
    const id = Number(attribute(match[1]!, 'numFmtId'))
    const code = attribute(match[1]!, 'formatCode')
    if (Number.isFinite(id) && code !== undefined) customIsDate.set(id, formatCodeIsDate(code))
  }

  // Then the cell formats, in order — a cell's `s` attribute indexes into this.
  // Must not pick up `cellStyleXfs`, which is a different list.
  const cellFormats = new RegExp(`<${NS}cellXfs\\b[^>]*>([\\s\\S]*?)<\\/${NS}cellXfs>`).exec(xml)
  if (!cellFormats) return []
  const out: boolean[] = []
  const xf = elementPattern('xf')
  while ((match = xf.exec(cellFormats[1]!)) !== null) {
    const id = Number(attribute(match[1]!, 'numFmtId') ?? '0')
    out.push(BUILTIN_DATE_FORMATS.has(id) || (customIsDate.get(id) ?? false))
  }
  return out
}

function readCellValue(
  attrs: string,
  body: string,
  parts: WorkbookParts,
  reference: string,
  sheetName: string,
): string {
  const type = attribute(attrs, 't') ?? 'n'

  if (type === 'inlineStr') return textRuns(body)

  // `str` is nominally a formula that evaluated to text, but some writers use it
  // for plain text too; either way the value is in `<v>`. `e` is a formula that
  // errored, and its error text ("#N/A") is the honest thing to surface.
  const valueMatch = elementPattern('v').exec(body)
  const raw = valueMatch ? decodeXmlText(valueMatch[2] ?? '') : ''
  if (raw === '') return ''

  if (type === 's') {
    const index = Number(raw)
    const resolved = parts.sharedStrings[index]
    if (resolved === undefined) {
      throw new Error(`${sheetName}!${reference} points at shared string ${raw}, which does not exist`)
    }
    return resolved
  }
  if (type === 'str' || type === 'e') return raw
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'

  // Numeric. Only its style says whether it is a date.
  const styleIndex = Number(attribute(attrs, 's') ?? '')
  if (Number.isFinite(styleIndex) && parts.styleIsDate[styleIndex]) {
    const serial = Number(raw)
    if (!Number.isFinite(serial)) {
      throw new Error(`${sheetName}!${reference} is styled as a date but holds "${raw}"`)
    }
    try {
      return serialToIso(serial, parts.use1904)
    }
    catch (error) {
      throw new Error(`${sheetName}!${reference}: ${(error as Error).message}`)
    }
  }

  const numeric = Number(raw)
  // Keep full precision and never a locale format, so Number() round-trips.
  return Number.isFinite(numeric) ? String(numeric) : raw
}

function readSheetRows(xml: string, parts: WorkbookParts, sheetName: string): string[][] {
  const rows: string[][] = []

  const rowPattern = elementPattern('row')
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    // Rows carry their own number and sparse sheets skip empties entirely, so
    // trust `r` rather than the order they appear in.
    const declared = Number(attribute(rowMatch[1]!, 'r'))
    const rowIndex = Number.isFinite(declared) && declared > 0 ? declared - 1 : rows.length
    const cells: string[] = []

    // Built fresh per row: a shared `g` pattern would carry its lastIndex over.
    const cellPattern = elementPattern('c')
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellPattern.exec(rowMatch[2] ?? '')) !== null) {
      const attrs = cellMatch[1]!
      const body = cellMatch[2] ?? ''
      const reference = attribute(attrs, 'r')
      const columnIndex = reference ? columnIndexOf(reference) : cells.length
      while (cells.length < columnIndex) cells.push('')
      cells[columnIndex] = readCellValue(attrs, body, parts, reference ?? '?', sheetName)
    }

    while (rows.length < rowIndex) rows.push([])
    rows[rowIndex] = cells
  }

  return rows
}

/**
 * An open workbook whose sheets are parsed only when asked for.
 *
 * Worth the indirection because these files are lopsided: Hulagi's export is
 * one 9 MB sheet, and reading its name should not cost parsing it.
 */
export interface XlsxWorkbook {
  /** Sheet names in the order the workbook declares them. */
  sheetNames: string[]
  /** One sheet by name. Throws if absent, listing what is there. */
  sheet: (name: string) => XlsxSheet
}

export function openXlsx(path: string): XlsxWorkbook {
  return openXlsxBuffer(readFileSync(path), path)
}

/** The same, from bytes already in hand (an upload). `label` names the source in errors. */
export function openXlsxBuffer(buf: Buffer, label = 'workbook'): XlsxWorkbook {
  const path = label
  const entries = readZipEntries(buf)

  const read = (name: string): string | undefined => {
    const entry = entries.get(name)
    return entry ? readZipEntry(buf, entry) : undefined
  }

  const workbookXml = read('xl/workbook.xml')
  if (!workbookXml) throw new Error(`${path} is not an xlsx workbook: xl/workbook.xml is missing`)

  const parts: WorkbookParts = {
    sharedStrings: readSharedStrings(read('xl/sharedStrings.xml')),
    styleIsDate: readStyles(read('xl/styles.xml')),
    use1904: new RegExp(`<${NS}workbookPr\\b[^>]*\\bdate1904\\s*=\\s*"(?:1|true)"`, 'i').test(workbookXml),
  }

  // rId → part name, so a sheet can be found however the writer ordered things.
  const relationshipTargets = new Map<string, string>()
  const relationship = elementPattern('Relationship')
  let relMatch: RegExpExecArray | null
  const relationshipsXml = read('xl/_rels/workbook.xml.rels') ?? ''
  while ((relMatch = relationship.exec(relationshipsXml)) !== null) {
    const id = attribute(relMatch[1]!, 'Id')
    const target = attribute(relMatch[1]!, 'Target')
    if (id && target) {
      relationshipTargets.set(
        id,
        target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`,
      )
    }
  }

  const declared: { name: string, partName: string }[] = []
  const sheetTag = elementPattern('sheet')
  let sheetMatch: RegExpExecArray | null
  while ((sheetMatch = sheetTag.exec(workbookXml)) !== null) {
    const attrs = sheetMatch[1]!
    const name = attribute(attrs, 'name')
    if (name === undefined) continue
    const relationshipId = attribute(attrs, 'r:id') ?? attribute(attrs, 'id')
    const partName = relationshipId ? relationshipTargets.get(relationshipId) : undefined
    if (!partName) throw new Error(`sheet "${name}" in ${path} has no readable part reference`)
    declared.push({ name, partName })
  }
  if (declared.length === 0) throw new Error(`${path} declares no sheets`)

  const parsed = new Map<string, XlsxSheet>()
  return {
    sheetNames: declared.map(sheet => sheet.name),
    sheet(name: string): XlsxSheet {
      const cached = parsed.get(name)
      if (cached) return cached
      const found = declared.find(sheet => sheet.name === name)
      if (!found) {
        throw new Error(
          `${path} has no sheet "${name}". It has: ${declared.map(s => s.name).join(', ')}`,
        )
      }
      const xml = read(found.partName)
      if (xml === undefined) {
        throw new Error(`sheet "${name}" points at ${found.partName}, which is not in the archive`)
      }
      const sheet: XlsxSheet = { name, rows: readSheetRows(xml, parts, name) }
      parsed.set(name, sheet)
      return sheet
    },
  }
}

/** Every sheet in the workbook, in the order the workbook declares them. */
export function readXlsx(path: string): XlsxSheet[] {
  const workbook = openXlsx(path)
  return workbook.sheetNames.map(name => workbook.sheet(name))
}

/** One sheet by name. Throws if it is absent, listing what is there. */
export function readXlsxSheet(path: string, name: string): XlsxSheet {
  return openXlsx(path).sheet(name)
}

/**
 * A sheet as records keyed by its header row.
 *
 * The header row has to be *found*, not assumed: every sheet in the owner's
 * geography workbook opens with two to four rows of prose notes before the real
 * columns start, and those notes are as "non-empty" as a header is. So the
 * caller declares the columns it needs and the header is the first row carrying
 * all of them. That makes a reshaped spreadsheet fail loudly here instead of
 * yielding records keyed by a sentence.
 */
export function readXlsxRecords(
  path: string,
  sheetName: string,
  requiredColumns: readonly string[],
): Record<string, string>[] {
  if (requiredColumns.length === 0) {
    throw new Error('readXlsxRecords needs at least one required column to locate the header row')
  }
  const sheet = readXlsxSheet(path, sheetName)

  const headerRow = sheet.rows.findIndex((row) => {
    const present = new Set(row.map(cell => cell.trim()))
    return requiredColumns.every(column => present.has(column))
  })
  if (headerRow === -1) {
    throw new Error(
      `sheet "${sheetName}" has no row containing all of: ${requiredColumns.join(', ')}`,
    )
  }

  const headers = (sheet.rows[headerRow] ?? []).map(cell => cell.trim())
  const seen = new Set<string>()
  for (const header of headers) {
    if (header === '') continue
    if (seen.has(header)) throw new Error(`sheet "${sheetName}" has two columns named "${header}"`)
    seen.add(header)
  }

  const records: Record<string, string>[] = []
  for (const row of sheet.rows.slice(headerRow + 1)) {
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      if (header !== '') record[header] = row[index] ?? ''
    })
    // Emptiness is judged on the named columns, not the raw row — a spacer row
    // carrying a stray value in an unlabelled column is still not a record.
    if (!Object.values(record).some(value => value.trim() !== '')) continue
    records.push(record)
  }
  return records
}

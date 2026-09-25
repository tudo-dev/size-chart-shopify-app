/**
 * Reading a supplier's size-chart picture into a transcript.
 *
 * The reader is a vision model. It is asked for one thing only: what the
 * picture SAYS — headings named from our word list, cells exactly as printed,
 * one row per size even when the supplier laid the sizes across the top.
 * It is never asked to convert a unit or round a number; `values.ts` does
 * that, the same way every time, so a rounding rule can change without
 * reading a single picture again.
 *
 * The call goes straight to the Messages API over fetch (no SDK): one request,
 * structured output held to `READ_CHART_SCHEMA`, a short back-off on a busy
 * answer, and every failure turned into a sentence the page can show.
 */

import { glossaryForPrompt, isMeasureKey, SIZE_HEADINGS } from '../../shared/size-chart/glossary'
import { READ_CHART_SCHEMA } from '../../shared/size-chart/chart'
import type { ReadChart, ReadColumn, ReadTable, TableKind } from '../../shared/size-chart/chart'
import { SOURCE_UNITS } from '../../shared/size-chart/values'
import type { SourceUnit } from '../../shared/size-chart/values'

export const DEFAULT_READER_MODEL = 'claude-opus-5'
export const READER_API_URL = 'https://api.anthropic.com/v1/messages'
export const READER_MAX_IMAGE_BYTES = 7 * 1024 * 1024 // the API takes 10 MB once base64-encoded

const RETRY_WAITS_MS = [2000, 5000, 10000]

export interface ReaderConfig {
  apiKey: string
  model: string
  url?: string
}

export interface ReadInput {
  image: Buffer
  mediaType: string
  productTitle?: string | null
  productType?: string | null
  store?: string | null
}

export interface ReadResult {
  read: ReadChart
  model: string
  tokensIn: number | null
  tokensOut: number | null
}

export interface ReaderDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/** The key and model from the server's environment, or null when no key is set. */
export function readerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReaderConfig | null {
  const apiKey = (env.ANTHROPIC_API_KEY ?? '').trim()
  if (apiKey === '') return null
  const model = (env.SIZE_CHART_READER_MODEL ?? '').trim() || DEFAULT_READER_MODEL
  return { apiKey, model }
}

const TABLE_KINDS: readonly TableKind[] = ['garment', 'fit', 'shoe', 'other']

export function buildReaderPrompt(input: Pick<ReadInput, 'productTitle' | 'productType' | 'store'>): { system: string, user: string } {
  const system = [
    'You transcribe size charts from Chinese supplier product pictures (1688.com) for an online clothing and shoe shop in Nepal.',
    'You are given ONE picture. Write down what it says, in the structure requested. Do not convert, round or reinterpret any number.',
    '',
    'Rules:',
    '1. One table entry per table of sizes in the picture. One ROW per size. If the sizes run across the top and the measurements down the side, turn it around: still one row per size, one column per measurement. That is normal and expected — do not warn about it.',
    `2. Name every column (except the size column) with a key from this word list, choosing the key that means the same as the printed heading. Use "other" only when none fits, and then put your own English for it in "english". Word list (key: printed words (English)):`,
    glossaryForPrompt(),
    `3. The size column is the one headed ${SIZE_HEADINGS.slice(0, 5).join(', ')} or similar; report its printed heading in "sizeHeading" and each size label exactly as printed ("M", "2XL", "39", "均码", "160/84A").`,
    '4. Cells: copy exactly what is printed, including units and ranges, e.g. "1尺7-1尺9", "80-100斤", "160-170CM", "245", "100斤以下", "". Never translate or convert a cell. An empty or dashed cell is "".',
    '5. "unit" per column: what the heading, a footnote ("单位：cm") or the cells say the column is in. Use "chi" for 尺, "jin" for 斤, "mm" when the heading says MM or the values are foot lengths like 245, "none" for size codes (EU, US, UK, CN), "unknown" when nothing says.',
    '6. "kind": "garment" for measurements of the item itself; "fit" for recommended body height/weight per size; "shoe" for shoe sizes with foot or insole length or code conversions; "other" for anything else worth keeping.',
    '7. A try-on report (试穿报告: testers, their height/weight, the size they wore, how it felt) is NOT a size chart. Do not include it as a table. If the picture has nothing but that, set isSizeChart false and say so in warnings.',
    '8. "imageComplete" is false when a table is visibly cut off at an edge of the picture.',
    '9. "notes": short supplier notes a customer should see, translated to plain English (measurement tolerance such as "measured flat by hand, allow 1-3 cm", fit advice such as "slim fit, size up for a loose fit"). Skip marketing text and care symbols. Leave out a note that only says which unit the table uses ("all measurements are in mm", "unit: cm"): the app converts every figure and labels its own units.',
    '10. "warnings": anything the person checking this chart must know — handwriting or watermark hiding digits, a value that looks wrong next to its neighbours, two different products in one picture, a unit you had to guess.',
    '11. Everything in "english", "titleEnglish", "notes" and "warnings" is in English.',
    '12. A shoe chart usually prints one code system per row (foot length, China, old China, US, UK, EU). Report every one of them as its own column and let the app decide which one a customer picks — do not leave any out, and do not warn about which one leads.',
  ].join('\n')

  const context: string[] = []
  if (input.productTitle) context.push(`Product: ${input.productTitle}`)
  if (input.productType) context.push(`Type: ${input.productType}`)
  if (input.store) context.push(`Sold as: ${input.store.toUpperCase() === 'WOMENS' ? 'women\'s' : input.store.toUpperCase() === 'MENS' ? 'men\'s' : input.store}`)
  const user = `${context.length > 0 ? `${context.join('. ')}.\n\n` : ''}Transcribe the size chart in this picture.`
  return { system, user }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value))
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString) : []
}

/** Hold the model's answer to the shape the rest of the app relies on; anything odd becomes `other`/`unknown`, never a crash. */
export function toReadChart(value: unknown): ReadChart {
  if (!value || typeof value !== 'object') throw new Error('the reader answered with something that is not a chart')
  const raw = value as Record<string, unknown>
  const tables: ReadTable[] = Array.isArray(raw.tables)
    ? raw.tables.filter((table): table is Record<string, unknown> => !!table && typeof table === 'object').map((table) => {
        const kind = TABLE_KINDS.includes(table.kind as TableKind) ? table.kind as TableKind : 'other'
        const columns: ReadColumn[] = Array.isArray(table.columns)
          ? table.columns.filter((column): column is Record<string, unknown> => !!column && typeof column === 'object').map(column => ({
              original: asString(column.original),
              measure: isMeasureKey(asString(column.measure)) ? asString(column.measure) as ReadColumn['measure'] : 'other',
              english: asString(column.english),
              unit: (SOURCE_UNITS as readonly string[]).includes(asString(column.unit)) ? asString(column.unit) as SourceUnit : 'unknown',
            }))
          : []
        const rows = Array.isArray(table.rows)
          ? table.rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').map(row => ({
              size: asString(row.size),
              cells: asStringArray(row.cells),
            }))
          : []
        return {
          kind,
          titleOriginal: asString(table.titleOriginal),
          titleEnglish: asString(table.titleEnglish),
          sizeHeading: asString(table.sizeHeading),
          columns,
          rows,
        }
      })
    : []
  return {
    isSizeChart: raw.isSizeChart === true,
    imageComplete: raw.imageComplete !== false,
    tables,
    notes: asStringArray(raw.notes),
    warnings: asStringArray(raw.warnings),
  }
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

interface ApiAnswer {
  content?: { type: string, text?: string }[]
  stop_reason?: string
  usage?: { input_tokens?: number, output_tokens?: number }
  model?: string
  error?: { type?: string, message?: string }
}

/**
 * Read one picture. Throws a plain sentence on failure: the key refused, the
 * picture too large, the model busy after three tries, an answer that is not
 * a chart.
 */
export async function readSizeChartImage(input: ReadInput, config: ReaderConfig, deps: ReaderDeps = {}): Promise<ReadResult> {
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  if (input.image.length > READER_MAX_IMAGE_BYTES) {
    throw new Error(`the picture is ${Math.round(input.image.length / 1024 / 1024)} MB, more than the reader accepts`)
  }
  const prompt = buildReaderPrompt(input)
  const body = JSON.stringify({
    model: config.model,
    max_tokens: 4096,
    system: prompt.system,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.image.toString('base64') } },
        { type: 'text', text: prompt.user },
      ],
    }],
    output_config: { format: { type: 'json_schema', schema: READ_CHART_SCHEMA } },
  })

  let lastFailure = ''
  for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
    let response: Response
    try {
      response = await doFetch(config.url ?? READER_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body,
      })
    }
    catch (error) {
      lastFailure = `the reader could not be reached (${error instanceof Error ? error.message : String(error)})`
      if (attempt < RETRY_WAITS_MS.length) {
        await sleep(RETRY_WAITS_MS[attempt]!)
        continue
      }
      throw new Error(lastFailure)
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('the reading key was refused; check ANTHROPIC_API_KEY on the server')
    }
    if (response.status === 429 || response.status === 529 || response.status >= 500) {
      lastFailure = `the reader answered ${response.status}${response.status === 429 ? ' (too many requests)' : response.status === 529 ? ' (overloaded)' : ''}`
      if (attempt < RETRY_WAITS_MS.length) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '')
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : RETRY_WAITS_MS[attempt]!)
        continue
      }
      throw new Error(`${lastFailure} three times; try again later`)
    }

    let answer: ApiAnswer
    try {
      answer = await response.json() as ApiAnswer
    }
    catch {
      throw new Error(`the reader answered ${response.status} with something that is not JSON`)
    }
    if (!response.ok) {
      throw new Error(`the reader answered ${response.status}: ${answer.error?.message ?? 'no reason given'}`)
    }
    if (answer.stop_reason === 'max_tokens') throw new Error('the reader ran out of room before finishing the chart')
    if (answer.stop_reason === 'refusal') throw new Error('the reader declined to read this picture')
    const text = answer.content?.find(block => block.type === 'text')?.text
    if (!text) throw new Error('the reader answered without any text')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    }
    catch {
      throw new Error('the reader answered with text that is not a chart')
    }
    return {
      read: toReadChart(parsed),
      model: answer.model ?? config.model,
      tokensIn: answer.usage?.input_tokens ?? null,
      tokensOut: answer.usage?.output_tokens ?? null,
    }
  }
  throw new Error(lastFailure || 'the reader did not answer')
}

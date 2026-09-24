/**
 * One cell of a supplier's size chart: reading what was printed, holding it
 * in one unit, printing it in two.
 *
 * The reader (a vision model) transcribes cells exactly as the picture shows
 * them — "1尺7-1尺9", "80-100斤", "160-170CM", "245", "100斤以下" — and this
 * file turns them into numbers in cm, kg or g. The conversion to inches and
 * pounds is done HERE, never by the model, so every screen prints the same
 * figure and a rounding rule can change without reading a picture again.
 */

import type { UnitFamily } from './glossary'

export type ChartValue
  = | { kind: 'number', value: number }
    | { kind: 'range', from: number, to: number }
    | { kind: 'atMost', value: number }
    | { kind: 'atLeast', value: number }
    | { kind: 'text', text: string }
    | { kind: 'empty' }

/** A unit as the supplier printed or implied it. `chi` is the Chinese foot (尺, 33.3 cm); `jin` the Chinese pound (斤, 500 g). */
export type SourceUnit = 'cm' | 'mm' | 'inch' | 'chi' | 'jin' | 'kg' | 'g' | 'none' | 'unknown'

export const SOURCE_UNITS: readonly SourceUnit[] = ['cm', 'mm', 'inch', 'chi', 'jin', 'kg', 'g', 'none', 'unknown']

export interface ParsedCell {
  value: ChartValue
  /** Set when the unit had to be assumed rather than read — a reviewer must see it. */
  assumed?: string
}

export type InchRounding = 'tenth' | 'quarter'

/** One decimal until the owner says otherwise (asked 2026-09-20). */
export const DEFAULT_INCH_ROUNDING: InchRounding = 'tenth'

const CM_PER_CHI = 100 / 3
const CM_PER_INCH = 2.54
const KG_PER_JIN = 0.5
const LB_PER_KG = 2.20462
const OZ_PER_G = 0.035274

const EMPTY_CELLS = new Set(['', '-', '—', '–', '/', 'n/a', 'na', '无', '－'])

/** Full-width digits and punctuation to their plain forms; every kind of dash to a hyphen; no spaces. */
function compact(raw: string): string {
  return raw
    .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xFF10 + 48))
    .replace(/[．]/g, '.')
    .replace(/[～〜~—–‐−]/g, '-')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，、]/g, ',')
    .replace(/\s+/g, '')
}

/** The unit the cell itself names, if any. Checked longest-first so 公斤 is kg, not 斤. */
function unitInCell(s: string): SourceUnit | null {
  if (/公斤|千克|kg/i.test(s)) return 'kg'
  if (/斤/.test(s)) return 'jin'
  if (/尺|寸/.test(s)) return 'chi'
  if (/厘米|公分|cm/i.test(s)) return 'cm'
  if (/毫米|mm/i.test(s)) return 'mm'
  if (/英寸|inch|inches|"|″/i.test(s) || /\d(in)$/i.test(s)) return 'inch'
  if (/克|(?<=\d)g$/i.test(s)) return 'g'
  return null
}

/** Strip every unit word the cell might carry (斤 included, once its unit has been noted), leaving digits, dots, hyphens and 尺/寸. */
function withoutUnitWords(s: string): string {
  return s
    .replace(/公斤|千克|厘米|公分|毫米|英寸|inches|inch|kg|cm|mm|in|″|"|克|g|斤/gi, '')
}

/** "1尺7", "2尺", "2尺2寸", "3尺2" → centimetres. Null when it is not a 尺 figure. */
function chiToCm(token: string): number | null {
  const match = /^(\d+)尺(?:(\d+)寸?)?$/.exec(token)
  if (!match) return null
  const chi = Number(match[1]) + (match[2] ? Number(match[2]) / 10 : 0)
  return chi * CM_PER_CHI
}

function plainNumber(token: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(token)) return null
  return Number(token)
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** A number in the cell's unit → the family's canonical unit (cm, kg, g, or the count itself). */
function toCanonical(value: number, unit: SourceUnit, family: UnitFamily): number {
  if (family === 'length') {
    if (unit === 'mm') return round1(value / 10)
    if (unit === 'inch') return round1(value * CM_PER_INCH)
    return round1(value) // cm, and chi is already cm
  }
  if (family === 'weight') {
    if (unit === 'jin') return round1(value * KG_PER_JIN)
    if (unit === 'g') return round1(value / 1000)
    return round1(value)
  }
  if (family === 'garmentWeight') {
    if (unit === 'kg') return Math.round(value * 1000)
    if (unit === 'jin') return Math.round(value * 500)
    return Math.round(value)
  }
  return value
}

/**
 * Read one cell as the picture shows it.
 *
 * `unitHint` is what the reader saw on the column (heading or footnote); a
 * unit written in the cell itself wins over it. A weight with no unit anywhere
 * is taken as 斤 when it is 60 or more (nobody recommends a 90 kg body weight
 * for a hoodie) and as kg below that — and says so, so the row is reviewed.
 */
export function parseCell(raw: string, family: UnitFamily, unitHint: SourceUnit): ParsedCell {
  const text = raw.trim()
  if (EMPTY_CELLS.has(text.toLowerCase())) return { value: { kind: 'empty' } }
  if (family === 'text') return { value: { kind: 'text', text } }

  let s = compact(text)
  let qualifier: 'atMost' | 'atLeast' | null = null
  if (/(以下|以内|及以下|≤|<=)/.test(s)) {
    qualifier = 'atMost'
    s = s.replace(/(及以下|以下|以内|≤|<=)/g, '')
  }
  else if (/(以上|及以上|≥|>=|\+$)/.test(s)) {
    qualifier = 'atLeast'
    s = s.replace(/(及以上|以上|≥|>=|\+$)/g, '')
  }
  s = s.replace(/约|左右|大约/g, '')

  const cellUnit = unitInCell(s)
  const digitsOnly = withoutUnitWords(s)
  const parts = digitsOnly.split(/-|到|至/).filter(part => part !== '')
  if (parts.length === 0 || parts.length > 2) return { value: { kind: 'text', text } }

  const numbers: number[] = []
  let sawChi = false
  for (const part of parts) {
    const chi = chiToCm(part)
    if (chi !== null) {
      sawChi = true
      numbers.push(chi)
      continue
    }
    const plain = plainNumber(part)
    if (plain === null) return { value: { kind: 'text', text } }
    numbers.push(plain)
  }

  if (family === 'count') {
    if (numbers.length === 2) return { value: { kind: 'range', from: numbers[0]!, to: numbers[1]! } }
    return { value: { kind: 'number', value: numbers[0]! } }
  }

  let unit: SourceUnit = sawChi ? 'chi' : (cellUnit ?? unitHint)
  let assumed: string | undefined
  if (unit === 'unknown' || unit === 'none') {
    if (family === 'length') unit = 'cm'
    else if (family === 'garmentWeight') unit = 'g'
    else {
      const largest = Math.max(...numbers)
      unit = largest >= 60 ? 'jin' : 'kg'
      assumed = `no unit was printed for "${text}", so it was taken as ${unit === 'jin' ? '斤 (half kilos)' : 'kg'}`
    }
  }

  const converted = numbers.map(n => toCanonical(n, unit, family))
  if (converted.length === 2) {
    const [a, b] = converted as [number, number]
    return { value: { kind: 'range', from: Math.min(a, b), to: Math.max(a, b) }, assumed }
  }
  const only = converted[0]!
  if (qualifier === 'atMost') return { value: { kind: 'atMost', value: only }, assumed }
  if (qualifier === 'atLeast') return { value: { kind: 'atLeast', value: only }, assumed }
  return { value: { kind: 'number', value: only }, assumed }
}

/** "108" not "108.0", "42.5", "56.7" — one decimal at most, no trailing zero. */
function figure(value: number): string {
  return String(round1(value))
}

const QUARTERS = ['', '¼', '½', '¾']

export function cmToInches(cm: number, rounding: InchRounding = DEFAULT_INCH_ROUNDING): string {
  const inches = cm / CM_PER_INCH
  if (rounding === 'quarter') {
    const quarters = Math.round(inches * 4)
    const whole = Math.floor(quarters / 4)
    const rest = quarters - whole * 4
    if (whole === 0 && rest > 0) return QUARTERS[rest]!
    return `${whole}${QUARTERS[rest]}`
  }
  return figure(inches)
}

export function kgToPounds(kg: number): string {
  return String(Math.round(kg * LB_PER_KG))
}

export function gToOunces(g: number): string {
  return figure(g * OZ_PER_G)
}

function convert(value: number, family: UnitFamily, system: 'metric' | 'imperial', rounding: InchRounding): string {
  if (system === 'metric') return family === 'garmentWeight' ? String(Math.round(value)) : figure(value)
  if (family === 'length') return cmToInches(value, rounding)
  if (family === 'weight') return kgToPounds(value)
  if (family === 'garmentWeight') return gToOunces(value)
  return figure(value)
}

/** The cell as printed in one unit system. Empty cells print as an empty string; the renderer decides the dash. */
export function formatValue(value: ChartValue, family: UnitFamily, system: 'metric' | 'imperial', rounding: InchRounding = DEFAULT_INCH_ROUNDING): string {
  switch (value.kind) {
    case 'empty': return ''
    case 'text': return value.text
    case 'number': return convert(value.value, family, system, rounding)
    case 'range': return `${convert(value.from, family, system, rounding)}-${convert(value.to, family, system, rounding)}`
    case 'atMost': return `up to ${convert(value.value, family, system, rounding)}`
    case 'atLeast': return `${convert(value.value, family, system, rounding)} or more`
  }
}

/** The unit printed in a column heading for each family and system; null when the column is unitless. */
export function unitLabel(family: UnitFamily, system: 'metric' | 'imperial'): string | null {
  if (family === 'length') return system === 'metric' ? 'cm' : 'in'
  if (family === 'weight') return system === 'metric' ? 'kg' : 'lb'
  if (family === 'garmentWeight') return system === 'metric' ? 'g' : 'oz'
  return null
}

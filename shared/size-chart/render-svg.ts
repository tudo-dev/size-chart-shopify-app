/**
 * A finished chart as one SVG picture: our own table, both units, our name
 * at the foot. The server turns it into a PNG for Shopify; the review page
 * shows the SVG itself. Pure string building, so a test can pin the output.
 *
 * Widths are estimated from character counts (DejaVu Sans runs about 0.6 em
 * per character), generous enough that nothing overlaps at the widths the
 * charts actually have.
 */

import type { PublishedChart, PublishedTable } from './chart'

export interface RenderOptions {
  /** The product's name. */
  title: string
  subtitle?: string | null
  brand?: string
}

const FONT = 'DejaVu Sans, Helvetica Neue, Arial, sans-serif'
const MIN_WIDTH = 960
const PAD = 48
const HEADER_HEIGHT = 58
const ROW_HEIGHT = 52
const CELL_PAD = 16
const CHAR_EM = 0.6

const COLOURS = {
  ink: '#111111',
  soft: '#6b7280',
  faint: '#9ca3af',
  line: '#e5e7eb',
  stripe: '#f7f7f8',
  headBg: '#111111',
  headText: '#ffffff',
  paper: '#ffffff',
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function textWidth(text: string, size: number): number {
  return text.length * size * CHAR_EM
}

function columnWidths(table: PublishedTable): number[] {
  return table.columns.map((column, index) => {
    const unitLine = column.metric && column.imperial ? `${column.metric} · ${column.imperial}` : ''
    let widest = Math.max(textWidth(column.label, 15), textWidth(unitLine, 12))
    for (const row of table.rows) {
      const metric = index === 0 ? row.size : (row.metric[index - 1] ?? '')
      const imperial = index === 0 ? '' : (row.imperial[index - 1] ?? '')
      widest = Math.max(widest, textWidth(metric, 18), textWidth(imperial, 13))
    }
    return Math.max(index === 0 ? 96 : 112, Math.ceil(widest + CELL_PAD * 2))
  })
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(word => word !== '')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (candidate.length > maxChars && line !== '') {
      lines.push(line)
      line = word
    }
    else {
      line = candidate
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

function text(x: number, y: number, content: string, attrs: string): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" ${attrs}>${escapeXml(content)}</text>`
}

export function renderChartSvg(chart: PublishedChart, options: RenderOptions): string {
  const brand = options.brand ?? 'tudoholic.com'
  const widths = chart.tables.map(columnWidths)
  const tableWidths = widths.map(list => list.reduce((sum, width) => sum + width, 0))
  const width = Math.max(MIN_WIDTH, PAD * 2 + Math.max(0, ...tableWidths), PAD * 2 + Math.ceil(textWidth(options.title, 30)))
  const parts: string[] = []
  let y = PAD

  y += 30
  parts.push(text(PAD, y, options.title, `font-size="30" font-weight="700" fill="${COLOURS.ink}"`))
  if (options.subtitle) {
    y += 26
    parts.push(text(PAD, y, options.subtitle, `font-size="16" fill="${COLOURS.soft}"`))
  }
  y += 22

  chart.tables.forEach((table, tableIndex) => {
    const cols = widths[tableIndex]!
    const tableWidth = tableWidths[tableIndex]!
    y += 30
    parts.push(text(PAD, y, table.title, `font-size="20" font-weight="700" fill="${COLOURS.ink}"`))
    y += 14

    // Heading band.
    parts.push(`<rect x="${PAD}" y="${y}" width="${tableWidth}" height="${HEADER_HEIGHT}" fill="${COLOURS.headBg}"/>`)
    let x = PAD
    table.columns.forEach((column, index) => {
      const unitLine = column.metric && column.imperial ? `${column.metric} · ${column.imperial}` : ''
      parts.push(text(x + CELL_PAD, y + (unitLine ? 25 : 35), column.label, `font-size="15" font-weight="700" fill="${COLOURS.headText}"`))
      if (unitLine) parts.push(text(x + CELL_PAD, y + 45, unitLine, `font-size="12" fill="${COLOURS.headText}" opacity="0.75"`))
      x += cols[index]!
    })
    y += HEADER_HEIGHT

    table.rows.forEach((row, rowIndex) => {
      if (rowIndex % 2 === 1) parts.push(`<rect x="${PAD}" y="${y}" width="${tableWidth}" height="${ROW_HEIGHT}" fill="${COLOURS.stripe}"/>`)
      let cx = PAD
      table.columns.forEach((column, index) => {
        if (index === 0) {
          parts.push(text(cx + CELL_PAD, y + 32, row.size, `font-size="18" font-weight="700" fill="${COLOURS.ink}"`))
        }
        else {
          const metric = row.metric[index - 1] ?? ''
          const imperial = row.imperial[index - 1] ?? ''
          const unitless = column.metric === null
          if (metric === '') {
            parts.push(text(cx + CELL_PAD, y + 32, '–', `font-size="18" fill="${COLOURS.faint}"`))
          }
          else if (unitless || metric === imperial) {
            parts.push(text(cx + CELL_PAD, y + 32, metric, `font-size="18" fill="${COLOURS.ink}"`))
          }
          else {
            parts.push(text(cx + CELL_PAD, y + 24, metric, `font-size="18" fill="${COLOURS.ink}"`))
            parts.push(text(cx + CELL_PAD, y + 43, imperial, `font-size="13" fill="${COLOURS.soft}"`))
          }
        }
        cx += cols[index]!
      })
      y += ROW_HEIGHT
      parts.push(`<line x1="${PAD}" y1="${y}" x2="${PAD + tableWidth}" y2="${y}" stroke="${COLOURS.line}" stroke-width="1"/>`)
    })
    y += 12
  })

  if (chart.notes.length > 0) {
    y += 22
    const maxChars = Math.floor((width - PAD * 2) / (14 * CHAR_EM))
    for (const note of chart.notes) {
      const lines = wrap(note, maxChars - 2)
      lines.forEach((line, index) => {
        parts.push(text(PAD, y, index === 0 ? `• ${line}` : `  ${line}`, `font-size="14" fill="${COLOURS.soft}"`))
        y += 21
      })
    }
  }

  y += 30
  const hasUnits = chart.tables.some(table => table.columns.some(column => column.metric !== null))
  const footer = hasUnits ? `${brand} · centimetres with inches below` : brand
  parts.push(text(PAD, y, footer, `font-size="13" fill="${COLOURS.faint}"`))
  y += PAD

  const height = y
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${COLOURS.paper}"/>`,
    ...parts,
    '</svg>',
  ].join('\n')
}

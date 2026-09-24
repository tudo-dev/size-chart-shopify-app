/**
 * The fixed English vocabulary a size chart may use.
 *
 * The reader (a vision model looking at the supplier's picture) must name
 * every column with one of these keys, or `other` together with its own
 * translation. Keeping the list here, in shared/, is what makes 胸围 read
 * "Chest" on the review page, in the PNG and on the storefront alike — never
 * "bust" on one screen and "chest" on another. Anything the list does not
 * know is flagged for a person rather than guessed.
 */

/** What kind of number a column holds; decides the unit and the conversion. */
export type UnitFamily = 'length' | 'weight' | 'garmentWeight' | 'count' | 'text'

export interface Measure {
  /** English column heading. */
  label: string
  /** Heading on a women's product, when it differs (胸围 is Bust, not Chest). */
  womens?: string
  /** How the supplier writes it — for the reader's prompt, and for tests. */
  original: readonly string[]
  family: UnitFamily
}

export const MEASURES = {
  chest: { label: 'Chest', womens: 'Bust', original: ['胸围', '胸宽'], family: 'length' },
  shoulder: { label: 'Shoulder', original: ['肩宽'], family: 'length' },
  sleeve: { label: 'Sleeve', original: ['袖长'], family: 'length' },
  length: { label: 'Length', original: ['衣长', '长度', '全长'], family: 'length' },
  backLength: { label: 'Back length', original: ['后中长', '后长', '后中'], family: 'length' },
  frontLength: { label: 'Front length', original: ['前长', '前中长'], family: 'length' },
  waist: { label: 'Waist', original: ['腰围'], family: 'length' },
  hip: { label: 'Hip', original: ['臀围', '坐围'], family: 'length' },
  halfHip: { label: 'Hip (half)', original: ['1/2坐围', '半臀围', '1/2臀围'], family: 'length' },
  thigh: { label: 'Thigh', original: ['大腿围', '腿围', '横裆'], family: 'length' },
  knee: { label: 'Knee', original: ['膝围'], family: 'length' },
  legOpening: { label: 'Leg opening', original: ['脚口', '裤口', '裤脚'], family: 'length' },
  pantsLength: { label: 'Pants length', original: ['裤长'], family: 'length' },
  inseam: { label: 'Inseam', original: ['内长', '内裤长'], family: 'length' },
  frontRise: { label: 'Front rise', original: ['前裆', '立裆', '裆长'], family: 'length' },
  backRise: { label: 'Back rise', original: ['后裆'], family: 'length' },
  hem: { label: 'Hem', original: ['脚围', '下摆', '摆围', '底摆'], family: 'length' },
  collar: { label: 'Collar', original: ['领围', '领宽', '领口'], family: 'length' },
  cuff: { label: 'Cuff', original: ['袖口'], family: 'length' },
  shoulderSleeve: { label: 'Shoulder to cuff', original: ['肩连袖', '连肩袖长', '通袖长'], family: 'length' },
  skirtLength: { label: 'Skirt length', original: ['裙长'], family: 'length' },
  height: { label: 'Height', original: ['身高', '推荐身高', '建议身高', '适合身高'], family: 'length' },
  weight: { label: 'Weight', original: ['体重', '推荐体重', '建议体重', '适合体重'], family: 'weight' },
  footLength: { label: 'Foot length', original: ['脚长', '脚长CM', '脚长（CM）', '足长'], family: 'length' },
  insoleLength: { label: 'Insole length', original: ['鞋内长', '内长'], family: 'length' },
  footWidth: { label: 'Foot width', original: ['脚宽', '前掌宽'], family: 'length' },
  heel: { label: 'Heel height', original: ['跟高', '鞋跟高'], family: 'length' },
  eu: { label: 'EU size', original: ['欧码', '欧洲码', '欧洲尺码'], family: 'count' },
  uk: { label: 'UK size', original: ['英码', '英国码'], family: 'count' },
  us: { label: 'US size', original: ['美码', '美国码'], family: 'count' },
  jp: { label: 'JP size', original: ['日本码', '日码'], family: 'count' },
  kr: { label: 'KR size', original: ['韩国码', '韩码'], family: 'count' },
  cn: { label: 'CN size', original: ['中国码', '中码'], family: 'count' },
  cnOld: { label: 'Old China size', original: ['中国旧码', '旧码'], family: 'count' },
  standardSize: { label: 'Standard size', original: ['标准码', '标准尺码', '常规码'], family: 'count' },
  intlSize: { label: 'International size', original: ['国际码', '国际尺码'], family: 'count' },
  garmentWeight: { label: 'Garment weight', original: ['重量', '克重'], family: 'garmentWeight' },
  age: { label: 'Age', original: ['年龄', '适合年龄'], family: 'text' },
} as const satisfies Record<string, Measure>

export type MeasureKey = keyof typeof MEASURES

export const MEASURE_KEYS = Object.keys(MEASURES) as MeasureKey[]

/** How the supplier heads the size column; the reader reports it, we always print "Size". */
export const SIZE_HEADINGS: readonly string[] = ['尺码', '尺寸', '码数', '规格', '型号', '鞋码', 'SIZE', 'Size']

export function isMeasureKey(value: string): value is MeasureKey {
  return Object.prototype.hasOwnProperty.call(MEASURES, value)
}

/**
 * The word-list key a printed heading means, or null.
 *
 * Used for the heading the reader does NOT name — the size column's own
 * ("尺码", "脚长CM") — so the app can tell a real size column from a
 * measurement the supplier happened to print down the left-hand side.
 * Longest spelling first, so 中国旧码 is not read as 中国码.
 */
export function measureFromHeading(heading: string): MeasureKey | null {
  const text = heading.replace(/\s+/g, '')
  if (text === '') return null
  let best: { key: MeasureKey, length: number } | null = null
  for (const key of MEASURE_KEYS) {
    for (const spelling of MEASURES[key].original) {
      if (text.includes(spelling) && (!best || spelling.length > best.length)) best = { key, length: spelling.length }
    }
  }
  return best?.key ?? null
}

/** The heading to print for a column, on a men's or a women's product. */
export function measureLabel(key: MeasureKey, store: string | null | undefined): string {
  const measure: Measure = MEASURES[key]
  if (measure.womens && (store ?? '').trim().toUpperCase() === 'WOMENS') return measure.womens
  return measure.label
}

/**
 * The word list as the reader's prompt spells it out: one line per key with
 * the supplier's own words, so the model maps 胸围 to `chest` and never to a
 * translation of its own choosing.
 */
export function glossaryForPrompt(): string {
  return MEASURE_KEYS
    .map(key => `${key}: ${MEASURES[key].original.join(' / ')} (${MEASURES[key].label})`)
    .join('\n')
}

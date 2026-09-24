<template>
  <Page full-width>
    <ui-title-bar title="Size charts">
      <button
        @click="load"
      >
        Refresh
      </button>
    </ui-title-bar>

    <div class="intro">
      <Text
        as="h1"
        variant="headingLg"
      >
        Size charts from 1688 to the website
      </Text>
      <Text
        as="p"
        tone="subdued"
      >
        Upload the listing team's sheet. For every product the app fetches the supplier's size-chart picture,
        reads it into an English table in centimetres and inches, and shows it here beside the original.
        A person approves each chart before it goes to Shopify; nothing reaches the website unseen.
      </Text>
    </div>

    <!-- Upload -->
    <div class="section">
      <Card>
        <Text
          as="h2"
          variant="headingMd"
        >
          Read the sheet
        </Text>
        <p class="hint">
          In Google Sheets choose File, Download, Microsoft Excel (.xlsx) and pick that file here. The app reads
          the "Size chart" tab (one row per 1688 product with its picture link). Uploading the same sheet again is
          safe: only rows with a new or changed picture link are read again.
        </p>
        <div class="upload-row">
          <input
            ref="fileInput"
            type="file"
            accept=".xlsx"
            :disabled="uploading"
            @change="onFileChosen"
          >
          <Button
            variant="primary"
            :disabled="!chosenFile || uploading"
            :loading="uploading"
            @click="upload"
          >
            {{ uploading ? 'Reading…' : 'Read the sheet' }}
          </Button>
        </div>
        <div
          v-if="uploadError"
          class="notice notice--bad"
        >
          {{ uploadError }}
        </div>
        <div
          v-if="uploadResult"
          class="upload-result"
        >
          <Text
            as="h3"
            variant="headingSm"
          >
            {{ uploadResult.fileName }}
          </Text>
          <p class="fine">
            {{ uploadLine }}
          </p>
          <p
            v-if="uploadResult.skipped > 0"
            class="fine"
          >
            {{ skippedLine }}
          </p>
        </div>
      </Card>
    </div>

    <div
      v-if="loadError"
      class="notice notice--bad"
    >
      {{ loadError }}
    </div>

    <!-- Where every chart stands -->
    <div
      v-if="summary"
      class="section"
    >
      <Card>
        <Text
          as="h2"
          variant="headingMd"
        >
          Where every chart stands
        </Text>
        <div class="tile-grid">
          <button
            v-for="tile in tiles"
            :key="tile.key"
            type="button"
            class="tile"
            :class="[`tile--${tile.key}`, { 'tile--on': filter.view === tile.key && filter.q === '' }]"
            @click="showView(tile.key)"
          >
            <span class="big">{{ tile.count.toLocaleString() }}</span>
            <span class="tile__words">{{ tile.words }}</span>
          </button>
        </div>
        <p
          v-if="jobLine"
          class="fine"
          :class="{ 'fine--bad': summary.lastJob?.status === 'failed' }"
        >
          {{ jobLine }}
        </p>
        <div
          v-if="summary.lastJob?.status === 'running' && summary.lastJob.total > 0"
          class="progress"
        >
          <div
            class="progress__bar"
            :style="{ width: `${Math.round((summary.lastJob.done / summary.lastJob.total) * 100)}%` }"
          />
        </div>
        <div class="products-row">
          <span class="fine">{{ productsLine }}</span>
          <Button
            :disabled="running || syncing"
            :loading="syncing"
            @click="syncProducts"
          >
            Sync products
          </Button>
        </div>
        <div class="products-row">
          <span
            class="fine"
            :class="{ 'fine--bad': !summary.reader.configured }"
          >{{ readerLine }}</span>
          <Button
            variant="primary"
            :disabled="running || reading || !summary.reader.configured || summary.counts.queued === 0"
            :loading="reading"
            @click="readPictures"
          >
            Read pictures
          </Button>
        </div>
        <div class="products-row">
          <Checkbox
            :checked="autoRead"
            label="Read the pictures by itself after every sheet upload"
            :disabled="savingSetting"
            @change="(checked: boolean) => saveSetting('autoRead', checked)"
          />
        </div>
        <p class="fine">
          Off means reading is always a press of Read pictures. Every reading costs a little money.
        </p>
        <div class="products-row">
          <Checkbox
            :checked="autoApprove"
            label="Let the app approve a chart by itself when nothing at all stands out"
            :disabled="savingSetting"
            @change="(checked: boolean) => saveSetting('autoApprove', checked)"
          />
        </div>
        <p class="fine">
          A chart with even one thing to check always waits for a person, whatever this switch says.
        </p>
      </Card>
    </div>

    <!-- The list -->
    <div class="section">
      <Card>
        <Text
          as="h2"
          variant="headingMd"
        >
          Every chart
        </Text>
        <div class="filter-row">
          <div class="filter-select">
            <Select
              v-model="filter.view"
              label="Which charts to show"
              label-hidden
              :options="viewOptions"
              :disabled="filter.q !== ''"
            />
          </div>
          <div class="filter-search">
            <TextField
              v-model="filter.q"
              label="Search charts"
              label-hidden
              placeholder="Search by product name, type or 1688 id"
              auto-complete="off"
              :clear-button="filter.q !== ''"
              @clear-button-click="filter.q = ''"
            />
          </div>
        </div>
        <p
          v-if="filter.q !== ''"
          class="fine"
        >
          {{ searchingLine }}
        </p>
        <template v-else>
          <p
            v-if="currentView.hint && list.total > 0"
            class="fine"
          >
            {{ currentView.hint }}
          </p>
          <p
            v-if="list.total === 0 && !list.loading"
            class="fine"
          >
            {{ noRowsLine }}
          </p>
        </template>
        <div
          v-if="list.rows.length > 0"
          class="table-scroll"
          :class="{ 'table-scroll--loading': list.loading }"
        >
          <table class="plain">
            <thead>
              <tr>
                <th class="serial">
                  S.N
                </th>
                <th>Product</th>
                <th>Type</th>
                <th>Status</th>
                <th>Picture</th>
                <th>What the app read</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, index) in list.rows"
                :key="row.id"
                :class="{ 'row--attention': row.status === 'needs-review' }"
              >
                <td class="serial">
                  {{ serial(list, index) }}
                </td>
                <td class="product">
                  <template v-if="row.products.length > 0">
                    <div
                      v-for="product in row.products"
                      :key="product.id"
                    >
                      <a
                        v-if="product.adminUrl"
                        :href="product.adminUrl"
                        target="_blank"
                        rel="noopener"
                      >{{ product.title }}</a>
                      <template v-else>
                        {{ product.title }}
                      </template>
                    </div>
                  </template>
                  <div
                    v-else
                    class="muted"
                  >
                    No Shopify product found yet
                  </div>
                  <div class="fine">
                    <a
                      v-if="row.sourceUrl"
                      :href="row.sourceUrl"
                      target="_blank"
                      rel="noopener"
                    >1688 · {{ row.sourceProductId }}</a>
                    <template v-else>
                      1688 · {{ row.sourceProductId }}
                    </template>
                    <template v-if="row.store">
                      · {{ storeWords(row.store) }}
                    </template>
                  </div>
                </td>
                <td class="nowrap">
                  {{ row.productType || '—' }}
                </td>
                <td>
                  <Badge :tone="statusTone(row.status)">
                    {{ statusWords(row.status) }}
                  </Badge>
                </td>
                <td class="nowrap">
                  {{ pictureWords(row) }}
                </td>
                <td class="reason">
                  {{ readWords(row) }}
                </td>
                <td class="nowrap">
                  {{ nepalDateTime(row.updatedAt) }}
                </td>
                <td class="nowrap">
                  <Button
                    size="slim"
                    @click="openChart(row.id)"
                  >
                    Open
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div
          v-if="list.total > 0"
          class="pager"
        >
          <span class="fine">{{ pagerLine(list) }}</span>
          <Button
            :disabled="list.page <= 1 || list.loading"
            @click="loadList(list.page - 1)"
          >
            Previous
          </Button>
          <Button
            :disabled="list.page * list.size >= list.total || list.loading"
            @click="loadList(list.page + 1)"
          >
            Next
          </Button>
        </div>
      </Card>
    </div>

    <!-- One chart, in full -->
    <Modal
      :open="detailOpen"
      :title="detailTitle"
      size="large"
      @close="closeChart"
    >
      <div class="detail">
        <div
          v-if="detailError"
          class="notice notice--bad"
        >
          {{ detailError }}
        </div>
        <template v-if="detail">
          <div class="detail__head">
            <Badge :tone="statusTone(detail.row.status)">
              {{ statusWords(detail.row.status) }}
            </Badge>
            <span class="fine">
              {{ detail.row.productType || 'No type' }}
              <template v-if="detail.row.store">
                · {{ storeWords(detail.row.store) }}
              </template>
              ·
              <a
                v-if="detail.row.sourceUrl"
                :href="detail.row.sourceUrl"
                target="_blank"
                rel="noopener"
              >Open on 1688</a>
              <template
                v-for="product in detail.row.products"
                :key="product.id"
              >
                ·
                <a
                  v-if="product.adminUrl"
                  :href="product.adminUrl"
                  target="_blank"
                  rel="noopener"
                >Open in Shopify</a>
              </template>
            </span>
          </div>
          <div
            v-if="detail.row.error"
            class="notice notice--bad"
          >
            {{ detail.row.error }}
          </div>
          <div class="detail__columns">
            <div class="detail__pane">
              <h3>Supplier's picture</h3>
              <img
                v-if="detail.image"
                :src="detail.image"
                alt="The supplier's size chart"
                class="detail__image"
              >
              <p
                v-else
                class="fine"
              >
                {{ detail.row.hasImage ? 'The picture has not been fetched yet.' : 'The sheet has no picture link for this product.' }}
              </p>
              <p
                v-if="detail.row.imageWidth && detail.row.imageHeight"
                class="fine"
              >
                {{ detail.row.imageWidth }} × {{ detail.row.imageHeight }} pixels
              </p>
            </div>
            <div class="detail__pane">
              <h3>What the app made of it</h3>
              <img
                v-if="detail.svg"
                :src="svgDataUrl(detail.svg)"
                alt="The chart the app made"
                class="detail__image detail__image--chart"
              >
              <p
                v-else
                class="fine"
              >
                {{ notReadLine }}
              </p>
              <p
                v-if="detail.row.confidence !== null && detail.svg"
                class="fine"
              >
                Confidence {{ Math.round(detail.row.confidence * 100) }}%
                <template v-if="detail.row.readAt">
                  · read {{ nepalDateTime(detail.row.readAt) }}
                </template>
              </p>
            </div>
          </div>
          <div
            v-if="detail.row.notices.length > 0"
            class="flags"
          >
            <h3>What the app changed</h3>
            <ul>
              <li
                v-for="(notice, index) in detail.row.notices"
                :key="index"
              >
                {{ notice }}
              </li>
            </ul>
          </div>
          <div
            v-if="detail.row.flags.length > 0"
            class="flags"
          >
            <h3>Things to check</h3>
            <ul>
              <li
                v-for="(flag, index) in detail.row.flags"
                :key="index"
              >
                {{ flag }}
              </li>
            </ul>
          </div>
          <div
            v-if="detail.chart && detail.chart.notes.length > 0"
            class="flags"
          >
            <h3>Notes kept from the supplier</h3>
            <ul>
              <li
                v-for="(note, index) in detail.chart.notes"
                :key="index"
              >
                {{ note }}
              </li>
            </ul>
          </div>
          <p
            v-if="detail.row.reviewedAt"
            class="fine"
          >
            {{ reviewLine(detail.row) }}
          </p>
          <div class="detail__actions">
            <TextField
              v-model="reviewNote"
              label="Note (optional)"
              placeholder="Why, in a few words"
              auto-complete="off"
            />
            <div class="detail__buttons">
              <Button
                variant="primary"
                :disabled="acting || !detail.svg || detail.row.status === 'published' || detail.row.status === 'approved'"
                @click="act('approve')"
              >
                Approve
              </Button>
              <Button
                :disabled="acting || detail.row.status === 'published' || detail.row.status === 'skipped'"
                @click="act('skip')"
              >
                Skip
              </Button>
              <Button
                :disabled="acting || !detail.row.hasImage || detail.row.status === 'published'"
                @click="act('read')"
              >
                {{ detail.svg ? 'Read again' : 'Read now' }}
              </Button>
              <Button @click="closeChart">
                Close
              </Button>
            </div>
          </div>
        </template>
        <p
          v-else-if="!detailError"
          class="fine"
        >
          Loading…
        </p>
      </div>
    </Modal>
  </Page>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Badge, Button, Card, Checkbox, Modal, Select, Text, TextField } from '@ownego/polaris-vue'
import { nepalDateTime } from '~~/shared/nepal-time'
import type { PublishedChart } from '~~/shared/size-chart/chart'

interface Job {
  id: number
  kind: string
  status: string
  total: number
  done: number
  failed: number
  note: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

interface Counts {
  'no-image': number
  'queued': number
  'image-failed': number
  'read-failed': number
  'needs-review': number
  'approved': number
  'publish-failed': number
  'published': number
  'skipped': number
  'total': number
  'unmatched': number
}

interface Summary {
  success: boolean
  error?: string
  counts: Counts
  products: { products: number, lastSyncedAt: string | null }
  lastUpload: { fileName: string, rows: number, createdAt: string } | null
  lastJob: Job | null
  reader: { configured: boolean, model: string }
  settings: { autoApprove: boolean, autoRead: boolean }
}

interface ChartProduct {
  id: string
  handle: string
  title: string
  status: string | null
  adminUrl: string | null
}

interface ChartRow {
  id: number
  sourceProductId: string
  sourceUrl: string | null
  productType: string | null
  store: string | null
  remark: string | null
  status: string
  hasImage: boolean
  imageWidth: number | null
  imageHeight: number | null
  confidence: number | null
  flags: string[]
  notices: string[]
  summary: string | null
  sizes: string[]
  products: ChartProduct[]
  error: string | null
  readAt: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  reviewNote: string | null
  publishedAt: string | null
  updatedAt: string
}

interface ListPage {
  rows: ChartRow[]
  total: number
  page: number
  size: number
  loading: boolean
}

interface ListResponse {
  success: boolean
  error?: string
  rows: ChartRow[]
  total: number
  page: number
  size: number
}

interface UploadResult {
  success: boolean
  error?: string
  fileName: string
  rows: number
  withImage: number
  added: number
  changed: number
  unchanged: number
  noImage: number
  toFetch: number
  skipped: number
  skippedRows: { rowNumber: number, reason: string }[]
  productsSheetName: string | null
  job: { jobId: number, started: boolean, alreadyRunning?: number }
}

interface Detail {
  success: boolean
  error?: string
  row: ChartRow
  imageUrl: string | null
  image: string | null
  chart: PublishedChart | null
  svg: string | null
}

const PAGE_SIZE = 30

interface View {
  key: string
  words: string
  count: (counts: Counts) => number
  hint?: string
  always?: boolean
}

const VIEWS: readonly View[] = [
  { key: 'review', words: 'Charts that need a look', count: c => c['needs-review'], always: true, hint: 'The app read these pictures but something stood out. Open each one, compare it with the supplier\'s picture, then Approve or Skip.' },
  { key: 'all', words: 'All charts', count: c => c.total, always: true },
  { key: 'queued', words: 'Waiting to be read', count: c => c.queued, hint: 'Pictures fetched or being fetched. The reading step comes next.' },
  { key: 'no-image', words: 'No picture in the sheet', count: c => c['no-image'], hint: 'The listing team found no size chart on 1688 for these products. Nothing to do until a link is added to the sheet.' },
  { key: 'approved', words: 'Approved, waiting to go to Shopify', count: c => c.approved },
  { key: 'published', words: 'On the website', count: c => c.published },
  { key: 'failed', words: 'Did not work', count: c => c['image-failed'] + c['read-failed'] + c['publish-failed'], hint: 'Open a row to see what went wrong. "Read again" sends it back to the queue.' },
  { key: 'skipped', words: 'Skipped by a person', count: c => c.skipped },
  { key: 'unmatched', words: 'No Shopify product found', count: c => c.unmatched, hint: 'No product in Shopify carries this 1688 id in its Source Product ID field. Check the id on the sheet, or press Sync products if the product was listed recently.' },
]

const fileInput = ref<HTMLInputElement | null>(null)
const chosenFile = ref<File | null>(null)
const uploading = ref(false)
const uploadError = ref('')
const uploadResult = ref<UploadResult | null>(null)

const summary = ref<Summary | null>(null)
const loadError = ref('')
const syncing = ref(false)
const reading = ref(false)
const savingSetting = ref(false)
const autoApprove = ref(false)
const autoRead = ref(false)

const filter = ref<{ view: string, q: string }>({ view: 'review', q: '' })
const list = ref<ListPage>({ rows: [], total: 0, page: 1, size: PAGE_SIZE, loading: false })

const detailOpen = ref(false)
const detail = ref<Detail | null>(null)
const detailError = ref('')
const reviewNote = ref('')
const acting = ref(false)

const running = computed(() => summary.value?.lastJob?.status === 'running')
const counts = computed<Counts | null>(() => summary.value?.counts ?? null)

const currentView = computed(() => VIEWS.find(view => view.key === filter.value.view) ?? VIEWS[0]!)

const viewOptions = computed(() => {
  const c = counts.value
  return VIEWS
    .filter(view => view.always || (c ? view.count(c) > 0 : false) || view.key === filter.value.view)
    .map(view => ({ value: view.key, label: c ? `${view.words} (${view.count(c).toLocaleString()})` : view.words }))
})

const tiles = computed(() => {
  const c = counts.value
  if (!c) return []
  return VIEWS
    .filter(view => view.key !== 'all' && (view.count(c) > 0 || view.key === 'review'))
    .map(view => ({ key: view.key, words: view.words, count: view.count(c) }))
})

function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  chosenFile.value = input.files?.[0] ?? null
  uploadError.value = ''
}

const uploadLine = computed(() => {
  const r = uploadResult.value
  if (!r) return ''
  const parts = [
    `${r.rows.toLocaleString()} ${r.rows === 1 ? 'product' : 'products'} in the sheet: ${r.withImage.toLocaleString()} with a picture link, ${r.noImage.toLocaleString()} without.`,
    `${r.added.toLocaleString()} new, ${r.changed.toLocaleString()} with a changed picture, ${r.unchanged.toLocaleString()} unchanged.`,
  ]
  if (r.toFetch > 0) parts.push(`Fetching ${r.toFetch.toLocaleString()} ${r.toFetch === 1 ? 'picture' : 'pictures'} now.`)
  if (r.productsSheetName) parts.push('The product names came from the export tab in the same workbook.')
  return parts.join(' ')
})

const skippedLine = computed(() => {
  const r = uploadResult.value
  if (!r || r.skipped === 0) return ''
  const first = r.skippedRows.slice(0, 3).map(row => `row ${row.rowNumber}: ${row.reason}`).join('; ')
  return `${r.skipped.toLocaleString()} ${r.skipped === 1 ? 'row was' : 'rows were'} left out (${first}${r.skipped > 3 ? '; …' : ''}).`
})

function jobKindWords(kind: string): string {
  if (kind === 'intake') return 'Matching products and fetching pictures'
  if (kind === 'read') return 'Reading pictures'
  if (kind === 'publish') return 'Sending charts to Shopify'
  return kind
}

const jobLine = computed(() => {
  const job = summary.value?.lastJob
  if (!job) return ''
  if (job.status === 'running') {
    const progress = job.total > 0 ? ` ${job.done.toLocaleString()} of ${job.total.toLocaleString()} done${job.failed > 0 ? `, ${job.failed.toLocaleString()} failed` : ''}.` : ''
    return `${jobKindWords(job.kind)}… ${job.note ?? ''}${progress}`.replace(/\s+/g, ' ').trim()
  }
  const when = job.finishedAt ? nepalDateTime(job.finishedAt) : ''
  if (job.status === 'failed') return `${jobKindWords(job.kind)} stopped ${when}: ${job.error ?? 'no reason recorded'}.`
  const failed = job.failed > 0 ? `, ${job.failed.toLocaleString()} did not work` : ''
  return `${jobKindWords(job.kind)} finished ${when}: ${job.done.toLocaleString()} ${job.done === 1 ? 'picture' : 'pictures'} handled${failed}.`
})

const productsLine = computed(() => {
  const p = summary.value?.products
  if (!p) return ''
  if (p.products === 0) return 'No products with a 1688 id on record yet. The first sheet upload reads them from Shopify.'
  return `${p.products.toLocaleString()} products with a 1688 id on record${p.lastSyncedAt ? `, last read from Shopify ${nepalDateTime(p.lastSyncedAt)}` : ''}.`
})

const readerLine = computed(() => {
  const r = summary.value?.reader
  if (!r) return ''
  if (!r.configured) return 'The reading key is not set on the server yet, so fetched pictures wait here. Add ANTHROPIC_API_KEY to the server\'s .env and restart the app.'
  return `Pictures are read with ${r.model}. Nothing goes to the website without an Approve.`
})

const notReadLine = computed(() => {
  const row = detail.value?.row
  if (!row) return ''
  if (!row.hasImage) return 'The sheet has no picture link for this product, so there is nothing to read.'
  if (row.status === 'image-failed') return 'The picture could not be fetched, so there is nothing to read yet.'
  if (row.status === 'read-failed') return 'The last reading did not work; the reason is above. Read now tries again.'
  if (!summary.value?.reader.configured) return 'Not read yet. The reading key is not set on the server.'
  return 'Not read yet. Press Read now, or Read pictures on the page for all of them.'
})

const searchingLine = computed(() => {
  const q = filter.value.q.trim()
  if (list.value.loading) return `Searching for ${q}…`
  return `${list.value.total.toLocaleString()} ${list.value.total === 1 ? 'chart matches' : 'charts match'} ${q}.`
})

const noRowsLine = computed(() => {
  if (filter.value.view === 'review') return 'Nothing is waiting for a look.'
  if (filter.value.view === 'all') return 'No charts yet. Upload the sheet to begin.'
  return 'No charts of that kind.'
})

function serial(page: { page: number, size: number }, index: number): number {
  return (page.page - 1) * page.size + index + 1
}

function pagerLine(page: ListPage): string {
  if (page.loading) return 'Loading…'
  const from = (page.page - 1) * page.size + 1
  const to = Math.min(page.page * page.size, page.total)
  return `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${page.total.toLocaleString()}`
}

function storeWords(store: string): string {
  const s = store.toUpperCase()
  if (s === 'MENS') return 'Men'
  if (s === 'WOMENS') return 'Women'
  if (s === 'KIDS') return 'Kids'
  return store
}

function statusWords(status: string): string {
  switch (status) {
    case 'no-image': return 'No picture in the sheet'
    case 'queued': return 'Waiting to be read'
    case 'image-failed': return 'Picture could not be fetched'
    case 'read-failed': return 'Could not be read'
    case 'needs-review': return 'Needs a look'
    case 'approved': return 'Approved'
    case 'publish-failed': return 'Did not reach Shopify'
    case 'published': return 'On the website'
    case 'skipped': return 'Skipped'
    default: return status
  }
}

function statusTone(status: string): 'success' | 'info' | 'attention' | 'critical' {
  if (status === 'needs-review') return 'attention'
  if (status === 'approved' || status === 'published') return 'success'
  if (status.endsWith('-failed')) return 'critical'
  return 'info'
}

function pictureWords(row: ChartRow): string {
  if (!row.hasImage) return '—'
  if (row.status === 'image-failed') return 'Not fetched'
  if (row.imageWidth && row.imageHeight) return `${row.imageWidth} × ${row.imageHeight}`
  return 'Fetching…'
}

function readWords(row: ChartRow): string {
  if (row.status === 'image-failed' || row.status === 'read-failed' || row.status === 'publish-failed') return row.error ?? 'Something went wrong'
  if (!row.summary) {
    if (row.status === 'no-image') return row.remark ?? 'No picture'
    return 'Not read yet'
  }
  const parts = [row.summary]
  if (row.flags.length > 0) parts.push(`${row.flags.length} ${row.flags.length === 1 ? 'thing' : 'things'} to check`)
  if (row.confidence !== null) parts.push(`${Math.round(row.confidence * 100)}% sure`)
  return parts.join(' · ')
}

function reviewLine(row: ChartRow): string {
  const who = row.reviewedBy === 'app' ? 'the app (nothing stood out)' : (row.reviewedBy ?? 'someone')
  const what = row.status === 'skipped' ? 'Skipped' : 'Approved'
  return `${what} by ${who} ${row.reviewedAt ? nepalDateTime(row.reviewedAt) : ''}${row.reviewNote ? ` — ${row.reviewNote}` : ''}`.trim()
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function plainError(caught: unknown, fallback: string): string {
  const error = caught as { data?: { statusMessage?: string, message?: string }, message?: string } | null
  const text = error?.data?.statusMessage ?? error?.data?.message ?? error?.message ?? ''
  if (text === '' || /fetch|network|Failed to fetch|ECONN/i.test(text)) return `${fallback} The connection to the app dropped; try again in a moment.`
  return text
}

const detailTitle = computed(() => {
  const row = detail.value?.row
  if (!row) return 'Size chart'
  return row.products[0]?.title ?? `1688 product ${row.sourceProductId}`
})

// On a first visit nothing has been read yet, so the default view (charts
// that need a look) would be empty while 84 rows sit one dropdown away.
// Once, when that is the case, the page opens on All charts instead.
let autoSwitched = false
function pickFirstView(c: Counts) {
  if (autoSwitched) return
  autoSwitched = true
  if (filter.value.view === 'review' && filter.value.q === '' && c['needs-review'] === 0 && c.total > 0) filter.value.view = 'all'
}

let listTicket = 0
async function loadList(page = list.value.page) {
  const ticket = ++listTicket
  list.value.loading = true
  try {
    const q = filter.value.q.trim()
    const response = await $fetch<ListResponse>('/api/size-charts/list', {
      query: { view: q ? 'all' : filter.value.view, q, page, size: PAGE_SIZE },
    })
    if (ticket !== listTicket) return
    if (!response.success) throw new Error(response.error ?? 'Could not load the charts.')
    list.value = { rows: response.rows, total: response.total, page: response.page, size: response.size, loading: false }
  }
  catch (caught: unknown) {
    if (ticket !== listTicket) return
    list.value.loading = false
    loadError.value = plainError(caught, 'Could not load the charts.')
  }
}

async function load() {
  loadError.value = ''
  try {
    const response = await $fetch<Summary>('/api/size-charts/summary')
    if (!response.success) throw new Error(response.error ?? 'Could not load the size charts.')
    summary.value = response
    autoApprove.value = response.settings?.autoApprove ?? false
    autoRead.value = response.settings?.autoRead ?? false
    pickFirstView(response.counts)
    await loadList()
  }
  catch (caught: unknown) {
    loadError.value = plainError(caught, 'Could not load the size charts.')
  }
}

function showView(view: string) {
  filter.value.q = ''
  filter.value.view = view
}

let timer: ReturnType<typeof setTimeout> | null = null
watch(() => filter.value.q, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void loadList(1), 350)
})
watch(() => filter.value.view, () => void loadList(1))

async function upload() {
  if (!chosenFile.value) return
  uploading.value = true
  uploadError.value = ''
  uploadResult.value = null
  try {
    const body = new FormData()
    body.append('file', chosenFile.value, chosenFile.value.name)
    const response = await $fetch<UploadResult>('/api/size-charts/upload', { method: 'POST', body })
    if (!response.success) throw new Error(response.error ?? 'The sheet could not be read.')
    uploadResult.value = response
    chosenFile.value = null
    if (fileInput.value) fileInput.value.value = ''
    await load()
    startPolling()
  }
  catch (caught: unknown) {
    uploadError.value = plainError(caught, 'The sheet could not be read.')
  }
  finally {
    uploading.value = false
  }
}

async function syncProducts() {
  syncing.value = true
  try {
    const response = await $fetch<{ success: boolean, error?: string }>('/api/size-charts/intake', { method: 'POST', body: { full: true } })
    if (!response.success) throw new Error(response.error ?? 'The sync could not start.')
    await load()
    startPolling()
  }
  catch (caught: unknown) {
    loadError.value = plainError(caught, 'The sync could not start.')
  }
  finally {
    syncing.value = false
  }
}

async function readPictures() {
  reading.value = true
  try {
    const response = await $fetch<{ success: boolean, error?: string }>('/api/size-charts/read', { method: 'POST' })
    if (!response.success) throw new Error(response.error ?? 'The reading could not start.')
    await load()
    startPolling()
  }
  catch (caught: unknown) {
    loadError.value = plainError(caught, 'The reading could not start.')
  }
  finally {
    reading.value = false
  }
}

async function saveSetting(which: 'autoApprove' | 'autoRead', checked: boolean) {
  savingSetting.value = true
  const target = which === 'autoApprove' ? autoApprove : autoRead
  target.value = checked
  try {
    const response = await $fetch<{ success: boolean, error?: string, settings?: { autoApprove: boolean, autoRead: boolean } }>('/api/size-charts/settings', {
      method: 'POST',
      body: { [which]: checked },
    })
    if (!response.success) throw new Error(response.error ?? 'The setting could not be saved.')
    autoApprove.value = response.settings?.autoApprove ?? autoApprove.value
    autoRead.value = response.settings?.autoRead ?? autoRead.value
  }
  catch (caught: unknown) {
    loadError.value = plainError(caught, 'The setting could not be saved.')
    autoApprove.value = summary.value?.settings.autoApprove ?? false
    autoRead.value = summary.value?.settings.autoRead ?? false
  }
  finally {
    savingSetting.value = false
  }
}

async function openChart(id: number) {
  detailOpen.value = true
  detail.value = null
  detailError.value = ''
  reviewNote.value = ''
  try {
    const response = await $fetch<Detail>(`/api/size-charts/${id}`)
    if (!response.success) throw new Error(response.error ?? 'Could not load the chart.')
    detail.value = response
  }
  catch (caught: unknown) {
    detailError.value = plainError(caught, 'Could not load the chart.')
  }
}

function closeChart() {
  detailOpen.value = false
}

async function act(action: 'approve' | 'skip' | 'read') {
  const current = detail.value
  if (!current) return
  acting.value = true
  detailError.value = ''
  try {
    const response = await $fetch<{ success: boolean, error?: string, row?: ChartRow }>(`/api/size-charts/${current.row.id}/${action}`, {
      method: 'POST',
      body: { note: reviewNote.value.trim() },
    })
    if (!response.success) throw new Error(response.error ?? 'That did not work.')
    if (response.row) detail.value = { ...current, row: response.row, svg: action === 'read' ? null : current.svg, chart: action === 'read' ? null : current.chart }
    await load()
    if (action === 'read') {
      startPolling()
      // The reading takes a few seconds; show the result the moment it lands.
      watchForReading(current.row.id)
    }
  }
  catch (caught: unknown) {
    detailError.value = plainError(caught, 'That did not work.')
  }
  finally {
    acting.value = false
  }
}

let readingWatch: ReturnType<typeof setInterval> | null = null
function watchForReading(id: number) {
  if (readingWatch) clearInterval(readingWatch)
  let ticks = 0
  readingWatch = setInterval(async () => {
    ticks++
    if (!detailOpen.value || detail.value?.row.id !== id || ticks > 60) {
      if (readingWatch) clearInterval(readingWatch)
      readingWatch = null
      return
    }
    try {
      const response = await $fetch<Detail>(`/api/size-charts/${id}`)
      if (response.success && response.row.status !== 'queued') {
        detail.value = response
        if (readingWatch) clearInterval(readingWatch)
        readingWatch = null
      }
    }
    catch {
      // Keep watching; the next tick asks again.
    }
  }, 2000)
}

let poller: ReturnType<typeof setInterval> | null = null
function startPolling() {
  stopPolling()
  poller = setInterval(async () => {
    await load()
    if (!running.value) stopPolling()
  }, 2500)
}
function stopPolling() {
  if (poller) clearInterval(poller)
  poller = null
}

onMounted(async () => {
  await load()
  if (running.value) startPolling()
})
onBeforeUnmount(() => {
  stopPolling()
  if (timer) clearTimeout(timer)
  if (readingWatch) clearInterval(readingWatch)
})
</script>

<style scoped>
.intro { display: grid; gap: 0.35rem; margin: 0.5rem 0 1rem; max-width: 72ch; }
.section { margin-bottom: 1rem; }
.hint { color: #6d7175; margin: 0.35rem 0 0.75rem; max-width: 80ch; font-size: 0.92rem; }
.fine { color: #6d7175; font-size: 0.82rem; margin-top: 0.15rem; }
.fine--bad { color: #8e1f0b; }
.muted { color: #6d7175; }
.upload-row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin: 0.5rem 0; }
.notice { padding: 0.6rem 0.8rem; border-radius: 6px; border: 1px solid #e1e3e5; margin-top: 0.75rem; }
.notice--bad { background: #fff4f4; border-color: #f1b7b7; color: #8e1f0b; }
.upload-result { margin-top: 0.75rem; display: grid; gap: 0.3rem; }
.progress { height: 8px; background: #e1e3e5; border-radius: 4px; overflow: hidden; margin: 0.5rem 0; max-width: 480px; }
.progress__bar { height: 100%; background: #1a5a96; transition: width 0.4s ease; }
.tile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin: 0.75rem 0 1rem; }
.tile { border: 1px solid #e1e3e5; border-left-width: 4px; border-radius: 8px; padding: 0.75rem; display: grid; gap: 0.15rem; background: #fff; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.tile:hover { background: #f6f6f7; }
.tile--on { box-shadow: inset 0 0 0 2px #303030; }
.tile--review { border-left-color: #b98900; }
.tile--queued, .tile--no-image { border-left-color: #8c9196; }
.tile--approved, .tile--published { border-left-color: #1f8a5b; }
.tile--failed, .tile--unmatched { border-left-color: #c43d2b; }
.tile--skipped { border-left-color: #5c6ac4; }
.tile__words { font-weight: 600; }
.big { font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.products-row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-top: 0.5rem; }
.filter-row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin: 0.5rem 0 0.75rem; }
.filter-select { flex: 0 1 340px; min-width: 240px; }
.filter-search { flex: 1 1 260px; max-width: 420px; margin-left: auto; }
.pager { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.6rem; }
.table-scroll { overflow-x: auto; }
.table-scroll--loading { opacity: 0.45; pointer-events: none; transition: opacity 0.15s ease; }
table.plain { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
table.plain th, table.plain td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #e1e3e5; vertical-align: top; }
table.plain th { color: #6d7175; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
table.plain .nowrap { white-space: nowrap; }
table.plain .serial { text-align: right; color: #6d7175; font-variant-numeric: tabular-nums; white-space: nowrap; width: 4ch; }
table.plain .reason { max-width: 40ch; }
table.plain .product { min-width: 22ch; max-width: 44ch; }
tr.row--attention td { background: #fffbf0; }
.detail { display: grid; gap: 0.75rem; }
.detail__head { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; }
.detail__columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
.detail__pane h3, .flags h3 { font-size: 0.9rem; font-weight: 600; margin: 0 0 0.4rem; color: #303030; }
.detail__image { max-width: 100%; height: auto; border: 1px solid #e1e3e5; border-radius: 6px; background: #fff; }
.detail__image--chart { background: #fff; }
.flags ul { margin: 0; padding-left: 1.2rem; font-size: 0.9rem; color: #303030; }
.flags li { margin: 0.2rem 0; }
.detail__actions { display: grid; gap: 0.6rem; margin-top: 0.25rem; }
.detail__buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; }
</style>

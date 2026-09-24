/**
 * Fetching a supplier's size-chart picture and keeping it.
 *
 * 1688's picture links die when a listing changes, so the original is copied
 * beside the database the first time it is seen (the same bytes are kept
 * once, under their sha256). The picture's kind is read from its first bytes,
 * never from the link — a `.jpg` link with `format,png` on the end is a PNG.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { databasePath } from './db'

export const IMAGE_MAX_BYTES = 15 * 1024 * 1024
export const IMAGE_FETCH_TIMEOUT_MS = 30_000

export type ImageKind = 'jpeg' | 'png' | 'gif' | 'webp'

export interface FetchedImage {
  sha256: string
  path: string
  bytes: number
  kind: ImageKind
  mediaType: string
  width: number | null
  height: number | null
}

/** Where the pictures live: beside the database, never in the repo. */
export function sizeChartImagesDir(): string {
  return join(dirname(databasePath()), 'size-chart-images')
}

export function imageKindOf(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png'
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return null
}

export function mediaTypeOf(kind: ImageKind): string {
  return kind === 'jpeg' ? 'image/jpeg' : `image/${kind}`
}

/** Width and height from the file's own header; null when the header is not where it should be. */
export function imageDimensions(buf: Buffer, kind: ImageKind): { width: number, height: number } | null {
  try {
    if (kind === 'png') {
      if (buf.length < 24) return null
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (kind === 'gif') {
      if (buf.length < 10) return null
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    if (kind === 'webp') {
      const chunk = buf.subarray(12, 16).toString('ascii')
      if (chunk === 'VP8 ' && buf.length >= 30) {
        return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF }
      }
      if (chunk === 'VP8L' && buf.length >= 25) {
        const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!
        return { width: 1 + (((b1 & 0x3F) << 8) | b0), height: 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6)) }
      }
      if (chunk === 'VP8X' && buf.length >= 30) {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      }
      return null
    }
    // JPEG: walk the markers to the first SOF (start of frame).
    let at = 2
    while (at + 9 < buf.length) {
      if (buf[at] !== 0xFF) {
        at++
        continue
      }
      const marker = buf[at + 1]!
      if (marker === 0xFF) {
        at++
        continue
      }
      // Markers without a length: start of image, restart markers, TEM.
      if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
        at += 2
        continue
      }
      const length = buf.readUInt16BE(at + 2)
      const isSof = (marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC
      if (isSof) return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) }
      if (marker === 0xDA) return null // scan data begins; no frame header before it
      at += 2 + length
    }
    return null
  }
  catch {
    return null
  }
}

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Keep the bytes under their hash (once) and describe them. */
export function keepImage(buf: Buffer): FetchedImage {
  const kind = imageKindOf(buf)
  if (!kind) throw new Error('the link did not give a picture (not a JPEG, PNG, GIF or WebP)')
  const sha256 = sha256Of(buf)
  const dir = sizeChartImagesDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sha256}.${kind === 'jpeg' ? 'jpg' : kind}`)
  if (!existsSync(path)) writeFileSync(path, buf)
  const size = imageDimensions(buf, kind)
  return { sha256, path, bytes: buf.length, kind, mediaType: mediaTypeOf(kind), width: size?.width ?? null, height: size?.height ?? null }
}

/**
 * Download one picture. Errors come back as plain sentences the page can show
 * beside the row ("the link answered 404", "the link took longer than 30 s").
 */
export async function fetchImage(url: string, deps: { fetch?: typeof fetch, timeoutMs?: number } = {}): Promise<FetchedImage> {
  const doFetch = deps.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await doFetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TudoholicLogistics/1.0)', 'Accept': 'image/*,*/*;q=0.8' },
      })
    }
    catch (error) {
      if (controller.signal.aborted) throw new Error(`the link took longer than ${Math.round((deps.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS) / 1000)} s to answer`)
      throw new Error(`the link could not be reached (${error instanceof Error ? error.message : String(error)})`)
    }
    if (!response.ok) throw new Error(`the link answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > IMAGE_MAX_BYTES) throw new Error(`the picture is ${Math.round(declared / 1024 / 1024)} MB, more than the ${IMAGE_MAX_BYTES / 1024 / 1024} MB the app accepts`)
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length === 0) throw new Error('the link answered with an empty file')
    if (buf.length > IMAGE_MAX_BYTES) throw new Error(`the picture is ${Math.round(buf.length / 1024 / 1024)} MB, more than the ${IMAGE_MAX_BYTES / 1024 / 1024} MB the app accepts`)
    return keepImage(buf)
  }
  finally {
    clearTimeout(timer)
  }
}

/** The kept bytes as a data URL for the review page (its CSP allows data: pictures, not 1688's). */
export function imageDataUrl(path: string): string | null {
  try {
    const buf = readFileSync(path)
    const kind = imageKindOf(buf)
    if (!kind) return null
    return `data:${mediaTypeOf(kind)};base64,${buf.toString('base64')}`
  }
  catch {
    return null
  }
}

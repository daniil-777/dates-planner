/**
 * Client-side photo handling for memories.
 *
 * Phone cameras produce 4–12 MB files; a memory thumbnail needs none of that,
 * and neither does a SQLite volume. Every picture is drawn into a canvas at a
 * bounded long edge and re-encoded as JPEG before it ever leaves the device.
 *
 * Persisting one is two steps, because that is what an OData media element is:
 * the `Photos` row is created as part of the Memory's composition (deep
 * insert/update through the documented `createMemory`/`updateMemory` calls),
 * then the bytes are PUT to that row's media stream at the URL the API client
 * hands out. Keys are minted here so the second step knows where to write.
 */

import { api } from '@/api/client'
import type { Photo } from '@/api/types'

export const MAX_EDGE_PX = 1440
export const JPEG_QUALITY = 0.82
export const MAX_PHOTOS_PER_MEMORY = 8

export interface PreparedPhoto {
  ID: string
  mediaType: string
  caption: string | null
  blob: Blob
  /** Object URL for the local preview; revoke it when the editor closes. */
  previewUrl: string
  bytes: number
}

export function newPhotoId(): string {
  const globalCrypto: Crypto | undefined = globalThis.crypto
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }
  // Fallback for insecure contexts: still a v4-shaped, collision-safe-enough id.
  const hex = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-'
    else if (i === 14) out += '4'
    else out += hex[Math.floor(Math.random() * 16)]
  }
  return out
}

function scaledSize(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= MAX_EDGE_PX) return { width, height }
  const ratio = MAX_EDGE_PX / longEdge
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) }
}

async function loadBitmap(
  file: Blob,
): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    }
  }
  const url = URL.createObjectURL(file)
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('The image could not be read'))
    image.src = url
  })
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('The image could not be encoded'))),
      type,
      quality,
    )
  })
}

/** Downscales and re-encodes one picked file. Throws on an unreadable image. */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const loaded = await loadBitmap(file)
  try {
    const { width, height } = scaledSize(loaded.width, loaded.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, width)
    canvas.height = Math.max(1, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser cannot resize images')
    context.drawImage(loaded.source, 0, 0, canvas.width, canvas.height)
    const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY)
    return {
      ID: newPhotoId(),
      mediaType: 'image/jpeg',
      caption: file.name ? file.name.replace(/\.[^.]+$/, '').slice(0, 200) : null,
      blob,
      previewUrl: URL.createObjectURL(blob),
      bytes: blob.size,
    }
  } finally {
    loaded.release()
  }
}

/** Uploads the bytes to an already-created Photos row. */
export async function uploadPhotoBinary(photo: PreparedPhoto): Promise<void> {
  const response = await fetch(api.photoImageUrl(photo.ID), {
    method: 'PUT',
    headers: { 'Content-Type': photo.mediaType },
    body: photo.blob,
  })
  if (!response.ok) {
    throw new Error(`Photo upload failed with ${response.status}`)
  }
}

/** The composition payload: what is kept plus what is new. */
export function photoRows(kept: readonly Photo[], added: readonly PreparedPhoto[]): Photo[] {
  return [
    ...kept.map(photo => ({
      ID: photo.ID,
      mediaType: photo.mediaType,
      caption: photo.caption ?? null,
    })),
    ...added.map(photo => ({
      ID: photo.ID,
      mediaType: photo.mediaType,
      caption: photo.caption,
    })),
  ]
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

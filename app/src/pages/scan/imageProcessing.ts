import { JPEG_QUALITY, MAX_LONG_EDGE, MAX_UPLOAD_BYTES } from './constants'

export interface PreparedImage {
  blob: Blob
  fileName: string
  width: number
  height: number
  /** False when the browser could not decode/re-encode and we send the original. */
  downscaled: boolean
}

interface Decoded {
  source: CanvasImageSource
  width: number
  height: number
  release: () => void
}

async function decodeImage(file: Blob, label: string): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    // 'from-image' applies the EXIF rotation a phone camera writes.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    }
  }

  const url = URL.createObjectURL(file)
  const img = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error(`Could not read ${label}`))
      img.src = url
    })
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  }
}

function targetSize(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= MAX_LONG_EDGE || longEdge === 0) return { width, height }
  const scale = MAX_LONG_EDGE / longEdge
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function toJpegName(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, '')
  return `${base || 'receipt'}.jpg`
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise(resolve => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null)
      return
    }
    canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality)
  })
}

/**
 * Downscale a camera photo before it goes near the network.
 *
 * A 12 MP phone JPEG is 4–6 MB and the action refuses anything over 10 MB, so
 * we do here what the backend would do anyway: cap the long edge at 2000 px and
 * re-encode at q85. Losing the decode is not fatal — the original is uploaded
 * instead and the server normalises it.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const fallback: PreparedImage = {
    blob: file,
    fileName: file.name || 'receipt.jpg',
    width: 0,
    height: 0,
    downscaled: false,
  }

  if (typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined') return fallback

  let decoded: Decoded
  try {
    decoded = await decodeImage(file, file.name || 'the image')
  } catch {
    return fallback
  }

  try {
    const size = targetSize(decoded.width, decoded.height)
    if (size.width === 0 || size.height === 0) return fallback

    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return fallback
    ctx.drawImage(decoded.source, 0, 0, size.width, size.height)

    let quality = JPEG_QUALITY
    let blob = await canvasToBlob(canvas, quality)
    // Belt and braces: a very busy 2000 px photo can still be large.
    while (blob && blob.size > MAX_UPLOAD_BYTES && quality > 0.5) {
      quality = Math.max(0.5, quality - 0.15)
      blob = await canvasToBlob(canvas, quality)
    }
    if (!blob) return fallback

    return {
      blob,
      fileName: toJpegName(file.name || 'receipt'),
      width: size.width,
      height: size.height,
      downscaled: true,
    }
  } finally {
    decoded.release()
  }
}

export function isImageFile(file: File): boolean {
  if (file.type !== '') return file.type.startsWith('image/')
  return /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(file.name)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

import sharp from 'sharp'

/**
 * Receipt image processing.
 *
 * Every byte that reaches the database goes through here first, for four reasons:
 *
 * 1. **Privacy.** A phone photo carries GPS coordinates, the device serial, and the
 *    exact capture time in EXIF/XMP/IPTC. This is a private household ledger;
 *    none of that belongs in it. sharp strips *all* metadata by default (it only
 *    keeps it when `keepMetadata()`/`withMetadata()` is called, which we never do),
 *    so re-encoding is the strip.
 * 2. **Orientation.** Stripping EXIF also drops the orientation flag, which would
 *    leave iPhone photos lying on their side. `.rotate()` with no argument bakes the
 *    EXIF orientation into the pixels, so it must run *before* the metadata is gone.
 * 3. **Size.** A modern phone photo is 3–8 MB; a receipt is legible at 2000 px on
 *    the long edge. Downscaling first keeps the SQLite file and the PWA cache small.
 * 4. **Transparency.** JPEG has no alpha channel, so a transparent e-receipt PNG
 *    would be composited onto black and arrive as an unreadable rectangle. See
 *    `open()`.
 *
 * Nothing in this module logs — not the buffer, not a slice of it, not a data URI.
 */

/** What went wrong, in a form a service handler can map to an OData error. */
export type ImageErrorCode = 'too_large' | 'unsupported_type' | 'decode_failed'

export class ImageError extends Error {
  readonly code: ImageErrorCode

  constructor(code: ImageErrorCode, message: string) {
    super(message)
    this.name = 'ImageError'
    this.code = code
  }
}

/** Upload ceiling from the brief: anything above 10 MB is rejected, not shrunk. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Receipts are legible well below this; the long edge is capped, never stretched. */
export const MAX_LONG_EDGE = 2000

export const JPEG_QUALITY = 85

export const DEFAULT_THUMBNAIL_SIZE = 320

/** Thumbnails are decoration; a lower quality halves their bytes with no visible cost. */
export const THUMBNAIL_QUALITY = 80

/**
 * Decode ceiling (80 megapixels ≈ 9000×9000).
 *
 * WHY: a 40 kB "image bomb" can declare a 30000×30000 canvas and ask libvips for
 * 3.6 GB of RAM. The byte-size check alone does not protect against that.
 */
const MAX_INPUT_PIXELS = 80_000_000

/** Paper is white; a transparent receipt is flattened onto paper, not onto ink. */
const WHITE = { r: 255, g: 255, b: 255 } as const

const MIME_ALIASES: Readonly<Record<string, string | undefined>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
}

/** Formats libvips can decode that a phone or a scanner actually produces. */
const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/heif',
])

export interface ProcessedImage {
  /** JPEG bytes, metadata-free and correctly oriented. */
  buffer: Buffer
  width: number
  height: number
  bytes: number
}

type SharpPipeline = ReturnType<typeof sharp>

/** `image/JPEG; charset=binary` and `image/jpg` are both really `image/jpeg`. */
function normaliseMimeType(mimeType: string): string {
  const bare = String(mimeType).split(';')[0].trim().toLowerCase()
  return MIME_ALIASES[bare] ?? bare
}

/** True for the image types `processReceiptImage` will accept. */
export function isSupportedImageType(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.has(normaliseMimeType(mimeType))
}

function assertWithinSizeLimit(input: Buffer): void {
  if (input.byteLength === 0) {
    throw new ImageError('decode_failed', 'the uploaded file is empty')
  }
  if (input.byteLength > MAX_UPLOAD_BYTES) {
    const limit = MAX_UPLOAD_BYTES / (1024 * 1024)
    throw new ImageError(
      'too_large',
      `image is ${input.byteLength} bytes, the limit is ${MAX_UPLOAD_BYTES} (${limit} MB)`,
    )
  }
}

/** Keeps libvips' own message (it never contains pixel data) without leaking bytes. */
function decodeFailure(error: unknown): ImageError {
  const reason = error instanceof Error ? error.message : 'unknown decoding error'
  return new ImageError('decode_failed', `could not read this image: ${reason}`)
}

async function encode(pipeline: SharpPipeline): Promise<ProcessedImage> {
  try {
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
    return { buffer: data, width: info.width, height: info.height, bytes: info.size }
  } catch (error) {
    throw decodeFailure(error)
  }
}

/**
 * Open an upload with the guards every path needs.
 *
 * `failOn: 'error'` rejects a truncated upload instead of storing half a receipt.
 * `.rotate()` is applied here so orientation survives the metadata strip.
 * `.flatten()` matters more than it looks: JPEG has no alpha channel, and libvips
 * composites a transparent image onto **black** when it drops one. An e-receipt or
 * an exported-PDF page is routinely a PNG with a transparent background and dark
 * text, so without this a perfectly good receipt is stored as a black rectangle —
 * unreadable to us and to Document AI. It is a no-op for the opaque camera photos
 * that make up almost every upload.
 */
function open(input: Buffer): SharpPipeline {
  return sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .flatten({ background: WHITE })
}

/**
 * Normalise an uploaded receipt: oriented, stripped, downscaled, JPEG q85.
 *
 * `fit: 'inside'` with equal width and height caps the **long** edge at
 * `MAX_LONG_EDGE`, and `withoutEnlargement` means a small photo is left at its own
 * size rather than being blown up into a blurry one.
 */
export async function processReceiptImage(
  input: Buffer,
  mimeType: string,
): Promise<ProcessedImage> {
  assertWithinSizeLimit(input)
  if (!isSupportedImageType(mimeType)) {
    throw new ImageError('unsupported_type', `${normaliseMimeType(mimeType)} is not an image`)
  }
  return encode(
    open(input)
      .resize({
        width: MAX_LONG_EDGE,
        height: MAX_LONG_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY }),
  )
}

/**
 * Small square-bounded preview for lists and the memories timeline.
 *
 * The MIME type is not re-checked: thumbnails are made from bytes that already came
 * through `processReceiptImage`, and anything else fails as `decode_failed` anyway.
 */
export async function thumbnail(
  input: Buffer,
  size: number = DEFAULT_THUMBNAIL_SIZE,
): Promise<ProcessedImage> {
  assertWithinSizeLimit(input)
  const edge = Number.isFinite(size) ? Math.max(1, Math.trunc(size)) : DEFAULT_THUMBNAIL_SIZE
  return encode(
    open(input)
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMBNAIL_QUALITY }),
  )
}

/**
 * A minimal ZIP writer.
 *
 * "Export everything" has to hand over one file, and one file that opens with a
 * double-click on any machine means a `.zip`. No archiver is installed and none is being
 * added for this, so this writes the format directly: local file headers, a central
 * directory, and an end-of-central-directory record, all with the **store** method — no
 * compression. That is deliberate. Deflate would need a compressor; the archive is a few
 * hundred kilobytes of JSON either way, and a stored ZIP is a completely valid ZIP.
 *
 * Format reference: PKWARE APPNOTE 6.3.4 §4.3.7 (local header), §4.3.12 (central
 * directory), §4.3.16 (end of central directory).
 */

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  name: string
  content: string | Uint8Array
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50

/** Version 2.0: the floor for "store", and what every unzip implementation accepts. */
const VERSION = 20

/** Bit 11 says the file name is UTF-8, which is the only reason accents survive. */
const UTF8_FLAG = 0x0800

const encoder = new TextEncoder()

/** Build a ZIP archive as a Blob, ready for a download link. */
export function createZip(entries: ZipEntry[], modified: Date = new Date()): Blob {
  const bytes = zipBytes(entries, modified)
  return new Blob([bytes], { type: 'application/zip' })
}

/**
 * The archive as bytes. Separated from the Blob so it can be asserted on byte by byte.
 *
 * The `<ArrayBuffer>` argument is not decoration: a bare `Uint8Array` is backed by
 * `ArrayBufferLike`, which might be shared memory, and `BlobPart` will not take one.
 */
export function zipBytes(
  entries: ZipEntry[],
  modified: Date = new Date(),
): Uint8Array<ArrayBuffer> {
  const { time, date } = dosTimestamp(modified)
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, LOCAL_HEADER, true)
    localView.setUint16(4, VERSION, true)
    localView.setUint16(6, UTF8_FLAG, true)
    localView.setUint16(8, 0, true) // method: store
    localView.setUint16(10, time, true)
    localView.setUint16(12, date, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, data.length, true)
    localView.setUint32(22, data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true) // extra field length
    local.set(nameBytes, 30)

    const entryHeader = new Uint8Array(46 + nameBytes.length)
    const entryView = new DataView(entryHeader.buffer)
    entryView.setUint32(0, CENTRAL_HEADER, true)
    entryView.setUint16(4, VERSION, true)
    entryView.setUint16(6, VERSION, true)
    entryView.setUint16(8, UTF8_FLAG, true)
    entryView.setUint16(10, 0, true)
    entryView.setUint16(12, time, true)
    entryView.setUint16(14, date, true)
    entryView.setUint32(16, crc, true)
    entryView.setUint32(20, data.length, true)
    entryView.setUint32(24, data.length, true)
    entryView.setUint16(28, nameBytes.length, true)
    entryView.setUint16(30, 0, true) // extra
    entryView.setUint16(32, 0, true) // comment
    entryView.setUint16(34, 0, true) // disk number
    entryView.setUint16(36, 0, true) // internal attributes
    entryView.setUint32(38, 0, true) // external attributes
    entryView.setUint32(42, offset, true)
    entryHeader.set(nameBytes, 46)

    parts.push(local, data)
    central.push(entryHeader)
    offset += local.length + data.length
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, END_OF_CENTRAL, true)
  endView.setUint16(4, 0, true) // this disk
  endView.setUint16(6, 0, true) // disk with the central directory
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  endView.setUint16(20, 0, true) // archive comment length

  const total = offset + centralSize + end.length
  const archive = new Uint8Array(total)
  let cursor = 0
  for (const part of [...parts, ...central, end]) {
    archive.set(part, cursor)
    cursor += part.length
  }
  return archive
}

/**
 * CRC-32 (IEEE 802.3), the same polynomial `zlib.crc32` uses.
 *
 * The table is built once, lazily: 256 entries is nothing, but neither is not doing it
 * until somebody actually exports.
 */
export function crc32(bytes: Uint8Array): number {
  const table = crcTable()
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

let cachedTable: Uint32Array | null = null

function crcTable(): Uint32Array {
  if (cachedTable !== null) return cachedTable
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  cachedTable = table
  return table
}

/** MS-DOS packed date and time — the only timestamp the base format has. */
function dosTimestamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear())
  const time =
    ((when.getHours() & 0x1f) << 11) |
    ((when.getMinutes() & 0x3f) << 5) |
    ((when.getSeconds() >> 1) & 0x1f)
  const date =
    (((year - 1980) & 0x7f) << 9) | (((when.getMonth() + 1) & 0x0f) << 5) | (when.getDate() & 0x1f)
  return { time, date }
}

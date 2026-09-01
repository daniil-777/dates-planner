/// <reference types="@cap-js/cds-types" />
/**
 * `npm run backup` — one file you can copy off the machine and sleep.
 *
 *     npx tsx scripts/backup.ts            # -> backups/twoway-match-<stamp>.tar.gz
 *     npx tsx scripts/backup.ts --out /Volumes/stick
 *
 * What goes in:
 *
 *   manifest.json      what this archive is, how many of everything, and from where
 *   db.sqlite          a consistent snapshot of the whole ledger
 *   images/receipts/…  every receipt scan, as a plain file
 *   images/photos/…    every memory photo, likewise
 *
 * The images are already inside `db.sqlite` as blobs, so the copies are redundant to
 * `scripts/restore.ts` — and that is exactly why they are here. A backup you cannot read
 * without the application that wrote it is a hostage, not a backup. In ten years the CDS
 * model will have moved on and `sqlite3` may be a nuisance to install; a folder of JPEGs
 * will still open.
 *
 * The snapshot uses SQLite's own online backup API (`node:sqlite`'s `backup()`), which
 * takes a transactionally consistent copy of a database that is being written to. Copying
 * the file with `cp` while the server is running can capture a torn page or miss a
 * write-ahead log; this cannot.
 *
 * The archive is a plain USTAR tarball, gzipped — `tar tzf` will list it and `tar xzf`
 * will unpack it, with no dependency on this repository. Writing the tar here rather than
 * shelling out to `tar(1)` keeps the format identical on every machine, and means the
 * script has no opinion about whether the system tar is GNU or BSD.
 */
import cds from '@sap/cds'
import { DatabaseSync, backup } from 'node:sqlite'
import { createGzip } from 'node:zlib'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Writable } from 'node:stream'

/** Where archives land unless `--out` says otherwise. Git-ignored. */
export const BACKUP_DIR = join(cds.root, 'backups')

export const MANIFEST_NAME = 'manifest.json'
export const DATABASE_NAME = 'db.sqlite'

/** Bumped only if the layout above changes; `restore.ts` refuses anything it cannot read. */
export const FORMAT_VERSION = 1

const TAR_BLOCK = 512

/** USTAR keeps the file name in 100 bytes. Every path this script writes is far shorter. */
const MAX_TAR_NAME = 100

export interface BackupImage {
  /** Path inside the archive, e.g. `images/receipts/<uuid>.jpg`. */
  path: string
  /** `Receipts` or `Photos` — which table the blob came out of. */
  table: 'Receipts' | 'Photos'
  id: string
  mediaType: string
  bytes: number
}

export interface BackupManifest {
  app: 'twoway-match'
  formatVersion: number
  createdAt: string
  appVersion: string
  database: { file: string; bytes: number; source: string }
  counts: Record<string, number>
  images: BackupImage[]
}

/** The tables whose row counts go into the manifest, so a restore can be sanity-checked. */
const COUNTED_TABLES = [
  'People',
  'Events',
  'EventParticipants',
  'Categories',
  'Expenses',
  'Receipts',
  'Memories',
  'Photos',
  'Settlements',
  'Statements',
  'Corrections',
] as const

const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/tiff': 'tif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

/* ------------------------------------------------------------------ *
 *  The backup
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const outDir = outputDirectory(process.argv.slice(2))
  const source = databaseFile()

  if (!existsSync(source)) {
    throw new Error(
      `no database at ${relative(cds.root, source)} — nothing to back up. Start the server ` +
        'once, or run `npx tsx scripts/export-training-data.ts`, to create it.',
    )
  }

  mkdirSync(outDir, { recursive: true })
  const stamp = new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z')
  const archivePath = join(outDir, `twoway-match-${stamp}.tar.gz`)
  const snapshotPath = join(outDir, `.snapshot-${stamp}.sqlite`)

  try {
    const { manifest, images } = await snapshot(source, snapshotPath)
    await writeArchive(archivePath, snapshotPath, manifest, images)
    report(archivePath, manifest)
  } finally {
    // The snapshot is an implementation detail of the archive; leaving a second copy of
    // the whole ledger lying about unencrypted is not what anyone asked for.
    //
    // The `-wal` and `-shm` beside it are part of that copy and have to go with it. The
    // snapshot inherits the source's WAL journal mode, so opening it to read the images
    // creates both, and closing a read-only connection leaves them on disk — one orphaned
    // pair per backup, in the directory the archives are kept in, holding the pages of a
    // database whose main file has just been deleted for exactly this reason.
    for (const path of [snapshotPath, `${snapshotPath}-wal`, `${snapshotPath}-shm`]) {
      rmSync(path, { force: true })
    }
  }
}

interface Snapshot {
  manifest: BackupManifest
  images: Map<string, Buffer>
}

/**
 * Take the consistent copy, then read the images out of that copy rather than out of the
 * live database — so the blobs and the rows that reference them come from the same instant.
 */
async function snapshot(source: string, snapshotPath: string): Promise<Snapshot> {
  const live = new DatabaseSync(source, { readOnly: true })
  try {
    const pages = await backup(live, snapshotPath)
    console.log(`snapshot: ${pages} page(s) copied from ${relative(cds.root, source)}`)
  } finally {
    live.close()
  }

  const copy = new DatabaseSync(snapshotPath, { readOnly: true })
  try {
    const images = new Map<string, Buffer>()
    const listed: BackupImage[] = []

    for (const [table, folder] of [
      ['Receipts', 'receipts'],
      ['Photos', 'photos'],
    ] as const) {
      for (const row of readImages(copy, table)) {
        const path = `images/${folder}/${row.id}.${extensionFor(row.mediaType)}`
        images.set(path, row.image)
        listed.push({
          path,
          table,
          id: row.id,
          mediaType: row.mediaType,
          bytes: row.image.byteLength,
        })
      }
    }

    return {
      images,
      manifest: {
        app: 'twoway-match',
        formatVersion: FORMAT_VERSION,
        createdAt: new Date().toISOString(),
        appVersion: appVersion(),
        database: {
          file: DATABASE_NAME,
          bytes: statSync(snapshotPath).size,
          source: relative(cds.root, source),
        },
        counts: countRows(copy),
        images: listed,
      },
    }
  } finally {
    copy.close()
  }
}

interface ImageRow {
  id: string
  mediaType: string
  image: Buffer
}

function readImages(db: DatabaseSync, table: 'Receipts' | 'Photos'): ImageRow[] {
  const rows = db
    .prepare(`SELECT ID, mediaType, image FROM twowaymatch_${table} WHERE image IS NOT NULL`)
    .all()

  const images: ImageRow[] = []
  for (const row of rows) {
    const record = row as Record<string, unknown>
    const image = record.image
    if (typeof record.ID !== 'string') continue
    // node:sqlite hands BLOBs back as Uint8Array; wrap without copying.
    if (!(image instanceof Uint8Array) || image.byteLength === 0) continue
    images.push({
      id: record.ID,
      mediaType:
        typeof record.mediaType === 'string' ? record.mediaType : 'application/octet-stream',
      image: Buffer.from(image.buffer, image.byteOffset, image.byteLength),
    })
  }
  return images
}

function countRows(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of COUNTED_TABLES) {
    const row = db.prepare(`SELECT count(*) AS n FROM twowaymatch_${table}`).get()
    const n = (row as Record<string, unknown> | undefined)?.n
    counts[table] = typeof n === 'number' ? n : 0
  }
  return counts
}

/* ------------------------------------------------------------------ *
 *  Writing the archive
 * ------------------------------------------------------------------ */

/**
 * Stream the tar through gzip and straight to disk.
 *
 * Streaming matters here: a few hundred receipts is a few hundred megabytes, and building
 * the whole tarball in memory before compressing it would be the one place in this app
 * that could run a small server out of RAM. Each image is held only while it is written.
 */
async function writeArchive(
  archivePath: string,
  snapshotPath: string,
  manifest: BackupManifest,
  images: Map<string, Buffer>,
): Promise<void> {
  const file = createWriteStream(archivePath)
  const gzip = createGzip({ level: 9 })
  gzip.pipe(file)

  const closed = new Promise<void>((done, failed) => {
    file.on('finish', done)
    file.on('error', failed)
    gzip.on('error', failed)
  })

  const now = new Date()
  await addEntry(gzip, MANIFEST_NAME, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), now)
  await addEntry(gzip, DATABASE_NAME, readFileSync(snapshotPath), now)
  for (const [path, data] of images) await addEntry(gzip, path, data, now)

  // Two zero blocks are what tells `tar` it has reached the end.
  await write(gzip, Buffer.alloc(TAR_BLOCK * 2))
  gzip.end()
  await closed
}

/** One USTAR file entry: a 512-byte header, the bytes, and padding to the next block. */
async function addEntry(sink: Writable, name: string, data: Buffer, mtime: Date): Promise<void> {
  await write(sink, tarHeader(name, data.byteLength, mtime))
  await write(sink, data)
  const padding = (TAR_BLOCK - (data.byteLength % TAR_BLOCK)) % TAR_BLOCK
  if (padding > 0) await write(sink, Buffer.alloc(padding))
}

function tarHeader(name: string, size: number, mtime: Date): Buffer {
  if (Buffer.byteLength(name, 'utf8') > MAX_TAR_NAME) {
    // Every name this script generates is a UUID under a fixed folder, so this is a
    // "someone changed the naming scheme" assertion rather than a real limitation. The
    // alternative — GNU long-name extensions — is not worth carrying for paths of 40 bytes.
    throw new Error(`archive entry name is too long for USTAR: ${name}`)
  }

  const header = Buffer.alloc(TAR_BLOCK)
  header.write(name, 0, MAX_TAR_NAME, 'utf8')
  writeOctal(header, 0o644, 100, 8) // mode
  writeOctal(header, 0, 108, 8) // uid: 0, so the archive does not carry this machine's user
  writeOctal(header, 0, 116, 8) // gid
  writeOctal(header, size, 124, 12)
  writeOctal(header, Math.floor(mtime.getTime() / 1000), 136, 12)
  header.write('        ', 148, 8, 'ascii') // checksum field counts as spaces while summing
  header.write('0', 156, 1, 'ascii') // typeflag: a regular file
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')

  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

/** USTAR numbers are NUL-terminated, zero-padded octal. */
function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

function write(sink: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve_, reject) => {
    sink.write(chunk, error => (error ? reject(error) : resolve_()))
  })
}

/* ------------------------------------------------------------------ *
 *  Reading an archive — used by scripts/restore.ts
 * ------------------------------------------------------------------ */

export interface TarEntry {
  name: string
  data: Buffer
}

/**
 * Parse an uncompressed USTAR buffer into its entries, verifying every header checksum.
 *
 * Restoring reads the whole archive into memory, unlike writing, which streams. That is a
 * deliberate asymmetry: a restore is a rare, deliberate act performed on a machine with
 * the archive already sitting on its disk, and random access to the entries makes the
 * "refuse to clobber, then verify" flow in `restore.ts` much easier to follow.
 */
export function readTarEntries(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0

  while (offset + TAR_BLOCK <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK)
    if (header.every(byte => byte === 0)) break

    verifyChecksum(header, offset)

    const name = cString(header, 0, MAX_TAR_NAME)
    const prefix = cString(header, 345, 155)
    const size = readOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156])

    offset += TAR_BLOCK
    if (offset + size > tar.byteLength) {
      throw new Error(`archive is truncated: ${name} claims ${size} bytes that are not there`)
    }

    // '0' and '\0' are both "regular file"; anything else (a directory, a long-name
    // extension from some other writer) is skipped rather than guessed at.
    if (typeflag === '0' || typeflag === '\0') {
      entries.push({
        name: prefix === '' ? name : `${prefix}/${name}`,
        data: Buffer.from(tar.subarray(offset, offset + size)),
      })
    }
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }

  return entries
}

function verifyChecksum(header: Buffer, offset: number): void {
  const stored = readOctal(header, 148, 8)
  let sum = 0
  for (let i = 0; i < TAR_BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]
  if (sum !== stored) {
    throw new Error(
      `archive is corrupt: bad header checksum at byte ${offset} (${stored} != ${sum})`,
    )
  }
}

function cString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8')
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const text = header
    .subarray(offset, offset + length)
    .toString('ascii')
    .replace(/[\0 ]/g, '')
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/* ------------------------------------------------------------------ *
 *  Shared odds and ends
 * ------------------------------------------------------------------ */

/**
 * The SQLite file CAP is configured to use, resolved the way CAP resolves it.
 *
 * Reading `cds.env` rather than hard-coding `db.sqlite` is what makes the script follow a
 * `cds.requires.db.credentials.url` override into `data/ledger.sqlite` or wherever a
 * deployment has put it.
 */
export function databaseFile(): string {
  const db: unknown = cds.env.requires?.db
  const credentials = typeof db === 'object' && db !== null ? Reflect.get(db, 'credentials') : null
  const url =
    typeof credentials === 'object' && credentials !== null
      ? Reflect.get(credentials, 'url')
      : undefined
  const file = typeof url === 'string' && url.length > 0 ? url : DATABASE_NAME
  return isAbsolute(file) ? file : join(cds.root, file)
}

export function extensionFor(mediaType: string): string {
  return MEDIA_EXTENSIONS[mediaType.split(';')[0].trim().toLowerCase()] ?? 'bin'
}

export function appVersion(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cds.root, 'package.json'), 'utf8'))
    const version =
      typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'version') : undefined
    return typeof version === 'string' ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** `--out <dir>`; relative paths are resolved against the shell's cwd, not `cds.root`. */
function outputDirectory(args: string[]): string {
  const flag = args.indexOf('--out')
  if (flag < 0) return BACKUP_DIR
  const value = args[flag + 1]
  if (value === undefined || value.startsWith('-')) throw new Error('--out needs a directory')
  return resolve(process.cwd(), value)
}

function report(archivePath: string, manifest: BackupManifest): void {
  const imageBytes = manifest.images.reduce((total, image) => total + image.bytes, 0)
  console.log(`wrote ${displayPath(archivePath)} (${human(statSync(archivePath).size)})`)
  console.log(`  ${MANIFEST_NAME}`)
  console.log(`  ${DATABASE_NAME}  ${human(manifest.database.bytes)}`)
  console.log(`  images/         ${manifest.images.length} file(s), ${human(imageBytes)}`)
  for (const [table, count] of Object.entries(manifest.counts)) {
    console.log(`    ${table.padEnd(12)} ${count}`)
  }
  console.log(`restore it with: npx tsx scripts/restore.ts ${displayPath(archivePath)}`)
}

function displayPath(path: string): string {
  const relatively = relative(cds.root, path)
  return relatively.startsWith('..') ? path : relatively
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

export function ensureDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

// Guarded so `scripts/restore.ts` can import the tar reader without taking a backup.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

/// <reference types="@cap-js/cds-types" />
/**
 * `scripts/backup.ts`, backwards.
 *
 *     npx tsx scripts/restore.ts                                   # newest archive, dry by default
 *     npx tsx scripts/restore.ts backups/twoway-match-….tar.gz --force
 *     npx tsx scripts/restore.ts … --force --images-dir ./receipts
 *
 * The one rule this script exists to enforce: **it will not overwrite a database you
 * already have.** Restoring is what you do after something went wrong, which is precisely
 * the state in which a wrong command line does the most damage — so without `--force` it
 * reads the archive, tells you exactly what it would do, and stops. With `--force` it
 * still moves the existing file aside before writing, because "I meant the other archive"
 * is a sentence people say.
 *
 * Two details that are easy to get wrong and expensive to get wrong:
 *
 *  - The stale `-wal` and `-shm` files beside the old database are deleted. SQLite would
 *    otherwise replay a write-ahead log belonging to a *different* database onto the
 *    restored one, which is a far more inventive kind of corruption than simply losing data.
 *  - The restored file is opened and counted against `manifest.json` before the script
 *    claims success. An archive that unpacks is not the same thing as a backup that worked.
 */
import cds from '@sap/cds'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import {
  BACKUP_DIR,
  DATABASE_NAME,
  FORMAT_VERSION,
  MANIFEST_NAME,
  databaseFile,
  ensureDirectory,
  readTarEntries,
  type BackupManifest,
} from './backup'

interface Options {
  archive: string
  force: boolean
  imagesDir: string | null
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  console.log(`reading ${display(options.archive)}`)

  const entries = new Map(
    readTarEntries(gunzipSync(readFileSync(options.archive))).map(entry => [
      entry.name,
      entry.data,
    ]),
  )

  const manifest = readManifest(entries)
  const database = entries.get(DATABASE_NAME)
  if (database === undefined) throw new Error(`${DATABASE_NAME} is missing from the archive`)

  describeArchive(manifest, database.byteLength)

  const target = databaseFile()
  if (existsSync(target) && !options.force) {
    throw new Error(
      `${display(target)} already exists, and this would replace it.\n` +
        'Nothing has been changed. Re-run with --force if that is what you meant:\n' +
        `  npx tsx scripts/restore.ts ${display(options.archive)} --force`,
    )
  }

  const replaced = setAside(target, options.force)
  ensureDirectory(target)
  writeFileSync(target, database)
  moveSidecars(target, replaced)

  console.log(`restored ${display(target)} (${human(database.byteLength)})`)
  if (replaced !== null) console.log(`  the previous database is at ${display(replaced)}`)

  const written = options.imagesDir === null ? 0 : writeImages(entries, manifest, options.imagesDir)
  if (options.imagesDir !== null) {
    console.log(`unpacked ${written} image(s) into ${display(options.imagesDir)}`)
  }

  verify(target, manifest)
}

/* ------------------------------------------------------------------ *
 *  Reading the archive
 * ------------------------------------------------------------------ */

function readManifest(entries: Map<string, Buffer>): BackupManifest {
  const raw = entries.get(MANIFEST_NAME)
  if (raw === undefined) {
    throw new Error(
      `${MANIFEST_NAME} is missing — this is a tarball, but not one scripts/backup.ts wrote`,
    )
  }

  const parsed: unknown = JSON.parse(raw.toString('utf8'))
  const manifest = parsed as Partial<BackupManifest>
  if (manifest.app !== 'twoway-match') {
    throw new Error(`this archive says it belongs to '${String(manifest.app)}', not twoway-match`)
  }
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new Error(
      `archive format ${String(manifest.formatVersion)} — this restore understands ` +
        `${FORMAT_VERSION}. Use the version of the app that wrote it.`,
    )
  }
  return manifest as BackupManifest
}

function describeArchive(manifest: BackupManifest, databaseBytes: number): void {
  console.log(`  taken ${manifest.createdAt} by twoway-match ${manifest.appVersion}`)
  console.log(`  ${DATABASE_NAME}  ${human(databaseBytes)}`)
  console.log(`  images/         ${manifest.images.length} file(s)`)
  const rows = Object.entries(manifest.counts)
    .map(([table, count]) => `${table} ${count}`)
    .join(', ')
  console.log(`  rows            ${rows}`)
}

/* ------------------------------------------------------------------ *
 *  Writing it back
 * ------------------------------------------------------------------ */

/**
 * Move the current database out of the way instead of deleting it.
 *
 * `--force` means "yes, replace it", not "yes, and I have thought hard about which archive
 * this is". The copy costs a rename and buys back the previous state.
 */
function setAside(target: string, force: boolean): string | null {
  if (!force || !existsSync(target)) return null
  const stamp = new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z')
  const kept = `${target}.replaced-${stamp}`
  renameSync(target, kept)
  return kept
}

/**
 * Deal with the `-wal`, `-shm` and `-journal` left beside the database that was replaced.
 *
 * They cannot stay next to `target`: they belong to a *different* database, and SQLite
 * would replay that write-ahead log into the restored file — a far more inventive kind of
 * corruption than simply losing data.
 *
 * Deleting them is wrong too, whenever there is a set-aside copy. In WAL mode the newest
 * committed transactions live in the `-wal` and not yet in the main file, so deleting it
 * silently truncates the copy this script has just announced as "the previous database" —
 * throwing away the very writes someone would come back for. They move with it instead,
 * under the names SQLite expects beside it, and are deleted only when `setAside` preserved
 * nothing and they are genuinely orphans.
 */
function moveSidecars(target: string, replaced: string | null): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${target}${suffix}`
    if (!existsSync(sidecar)) continue

    if (replaced === null) {
      rmSync(sidecar, { force: true })
      console.log(`  removed the stale ${display(sidecar)}`)
    } else {
      renameSync(sidecar, `${replaced}${suffix}`)
      console.log(`  kept ${display(sidecar)} with it, as ${display(`${replaced}${suffix}`)}`)
    }
  }
}

/**
 * Unpack the plain-file copies of the receipts.
 *
 * Off by default, because the images are already inside the database that has just been
 * restored — writing them again would be a second, unmanaged copy of the most private
 * thing in the archive. `--images-dir` exists for the day you want to look at a receipt
 * without starting the app.
 */
function writeImages(
  entries: Map<string, Buffer>,
  manifest: BackupManifest,
  imagesDir: string,
): number {
  // Up front, not after the loop: an archive with no images would otherwise have the line
  // below report unpacking them into a directory that was never created.
  mkdirSync(imagesDir, { recursive: true })

  let written = 0
  for (const image of manifest.images) {
    const data = entries.get(image.path)
    if (data === undefined) {
      console.warn(`  ! ${image.path} is listed in the manifest but not in the archive`)
      continue
    }
    const path = join(imagesDir, image.path)
    ensureDirectory(path)
    writeFileSync(path, data)
    written += 1
  }
  return written
}

/* ------------------------------------------------------------------ *
 *  Proving it worked
 * ------------------------------------------------------------------ */

/**
 * Open the restored database and count it against the manifest.
 *
 * This is the difference between "the archive unpacked" and "the backup worked". A
 * mismatch is reported rather than thrown: the file on disk is the best copy available at
 * that point, and deleting it because a count is off would be strictly worse than saying so.
 */
function verify(target: string, manifest: BackupManifest): void {
  const db = new DatabaseSync(target, { readOnly: true })
  try {
    let mismatches = 0
    for (const [table, expected] of Object.entries(manifest.counts)) {
      const row = db.prepare(`SELECT count(*) AS n FROM twowaymatch_${table}`).get()
      const actual = (row as Record<string, unknown> | undefined)?.n
      if (actual !== expected) {
        console.warn(`  ! ${table}: expected ${expected} row(s), found ${String(actual)}`)
        mismatches += 1
      }
    }

    const blobs = countImages(db)
    if (blobs !== manifest.images.length) {
      console.warn(`  ! images: expected ${manifest.images.length}, found ${blobs} in the database`)
      mismatches += 1
    }

    if (mismatches === 0) {
      const rows = Object.values(manifest.counts).reduce((total, count) => total + count, 0)
      console.log(`verified: ${rows} row(s) and ${blobs} image(s) match the manifest`)
    } else {
      console.warn(`verified with ${mismatches} mismatch(es) — the file is restored, but check it`)
      process.exitCode = 1
    }
  } finally {
    db.close()
  }
}

function countImages(db: DatabaseSync): number {
  let total = 0
  for (const table of ['Receipts', 'Photos']) {
    const row = db
      .prepare(`SELECT count(*) AS n FROM twowaymatch_${table} WHERE image IS NOT NULL`)
      .get()
    const n = (row as Record<string, unknown> | undefined)?.n
    total += typeof n === 'number' ? n : 0
  }
  return total
}

/* ------------------------------------------------------------------ *
 *  Command line
 * ------------------------------------------------------------------ */

function parseArgs(args: string[]): Options {
  let archive: string | null = null
  let force = false
  let imagesDir: string | null = null

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--force') force = true
    else if (arg === '--images-dir') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--images-dir needs a path')
      imagesDir = resolve(process.cwd(), value)
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else archive = resolve(process.cwd(), arg)
  }

  return { archive: archive ?? newestArchive(), force, imagesDir }
}

function newestArchive(): string {
  if (!existsSync(BACKUP_DIR)) {
    throw new Error(`no ${relative(cds.root, BACKUP_DIR)} directory — name an archive to restore`)
  }
  // The names embed an ISO timestamp, so lexical order is chronological order.
  const archives = readdirSync(BACKUP_DIR)
    .filter(name => name.endsWith('.tar.gz'))
    .sort()
  const newest = archives.at(-1)
  if (newest === undefined) {
    throw new Error(`no .tar.gz archives in ${relative(cds.root, BACKUP_DIR)}`)
  }
  console.log(`no archive named; taking the newest of ${archives.length}`)
  return join(BACKUP_DIR, newest)
}

function usage(): void {
  console.log(
    [
      'Usage: npx tsx scripts/restore.ts [archive.tar.gz] [--force] [--images-dir <dir>]',
      '',
      '  archive        the .tar.gz to restore. Defaults to the newest in backups/.',
      '  --force        actually replace an existing database. Without this the script',
      '                 reports what it would do and changes nothing. The database it',
      '                 replaces is renamed, never deleted.',
      '  --images-dir   also unpack the plain-file copies of the receipts and photos.',
      '                 They are already inside the restored database; this is for',
      '                 reading them without the app.',
    ].join('\n'),
  )
}

const display = (path: string): string => {
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

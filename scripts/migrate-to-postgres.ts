/**
 * Copy a SQLite database into Postgres, once — CONTRACTS.md §15.3.
 *
 *   DATABASE_URL=postgres://… npx tsx scripts/migrate-to-postgres.ts --from db.sqlite --dry-run
 *   DATABASE_URL=postgres://… npx tsx scripts/migrate-to-postgres.ts --from db.sqlite
 *
 * ## What this is for, and what it is not
 *
 * It moves the rows. It does **not** create the schema: start the app once against the empty
 * Postgres and let `migrate()` build it from the model, exactly as it does on the volume
 * today. Two mechanisms that both create tables is one mechanism too many, and the one that
 * runs at every boot is the one that has to be right.
 *
 * It is one-way and one-shot. There is no incremental mode and no "sync": copying a live
 * database twice is how a household ends up with two of every receipt. The procedure is
 * stop, copy, verify, start — written out in `docs/DEPLOY.md`.
 *
 * ## Why the raw drivers
 *
 * `node:sqlite` to read and `pg` to write, rather than two CAP connections. CAP is very good
 * at hiding which store it is talking to, and this is the one job where that is precisely
 * wrong: the whole task is the differences between them. Both drivers are already present —
 * `node:sqlite` ships with Node 22, `pg` comes with `@cap-js/postgres` — so this adds no
 * dependency.
 *
 * ## The three differences that actually matter
 *
 * 1. **Booleans.** SQLite has none; CAP stores them as `0` and `1`. Postgres will reject an
 *    integer for a `boolean` column outright, so every value is coerced against the *target*
 *    column type, read from `information_schema` rather than guessed from the value. A `0`
 *    is a perfectly good integer and a perfectly good `false`, and only the target knows
 *    which one is wanted.
 * 2. **Binaries.** Receipts, photographs and voice notes are `BLOB` in SQLite and `BYTEA` in
 *    Postgres. `node:sqlite` hands them back as `Uint8Array`, which `pg` writes correctly as
 *    long as it is a `Buffer` — so they are wrapped rather than stringified, which is what
 *    would otherwise silently store the text "[object Uint8Array]" in place of a photograph.
 * 3. **Identifier case.** CAP creates tables unquoted, so Postgres holds them lower-cased.
 *    Every name is matched case-insensitively and quoted on the way in.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

import pg from 'pg'

import { parsePostgresUrl } from '../srv/lib/database'

/** Rows per `INSERT`. Large enough to be fast, small enough that one bad row is findable. */
const BATCH = 200

interface Options {
  from: string
  dryRun: boolean
  force: boolean
}

function options(argv: readonly string[]): Options {
  const value = (flag: string, fallback: string): string => {
    const at = argv.indexOf(flag)
    return at === -1 ? fallback : (argv[at + 1] ?? fallback)
  }
  return {
    from: value('--from', 'db.sqlite'),
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
  }
}

/** Tables SQLite holds that are ours — the model's, plus the migration ledger. */
function sourceTables(sqlite: DatabaseSync): string[] {
  const rows = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

interface TargetTable {
  /** As Postgres actually spells it, which is lower case. */
  name: string
  /** Column name (lower case) to its declared type. */
  columns: Map<string, string>
}

async function targetTables(client: pg.Client): Promise<Map<string, TargetTable>> {
  const { rows } = await client.query<{
    table_name: string
    column_name: string
    data_type: string
  }>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema()`,
  )
  const tables = new Map<string, TargetTable>()
  for (const row of rows) {
    const key = row.table_name.toLowerCase()
    const found = tables.get(key) ?? { name: row.table_name, columns: new Map() }
    found.columns.set(row.column_name.toLowerCase(), row.data_type)
    tables.set(key, found)
  }
  return tables
}

/**
 * One value, as the target column wants it.
 *
 * The target's declared type decides, never the value's shape — see the header. Anything
 * this does not recognise is passed through, because `pg` already knows how to send a string,
 * a number or null, and a clever guess here would only ever make things worse.
 */
function coerce(value: unknown, type: string | undefined): unknown {
  if (value === null || value === undefined) return null
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true'
    return null
  }
  if (type === 'bytea') {
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
    return value
  }
  return value
}

async function main(): Promise<void> {
  const { from, dryRun, force } = options(process.argv.slice(2))

  if (!existsSync(from)) throw new Error(`No SQLite database at ${from}`)
  const url = process.env.DATABASE_URL?.trim()
  if (url === undefined || url.length === 0) {
    throw new Error('DATABASE_URL must name the Postgres to copy into.')
  }

  const sqlite = new DatabaseSync(from, { readOnly: true })
  const client = new pg.Client(parsePostgresUrl(url))
  await client.connect()

  try {
    const target = await targetTables(client)
    if (target.size === 0) {
      throw new Error(
        'The target has no tables. Start the app against it once so migrate() builds the ' +
          'schema from the model, then run this.',
      )
    }

    const tables = sourceTables(sqlite)
    let copied = 0
    let skipped = 0
    const report: string[] = []

    for (const table of tables) {
      const destination = target.get(table.toLowerCase())
      if (destination === undefined) {
        report.push(`  ${table.padEnd(34)} — not in the target, skipped`)
        skipped += 1
        continue
      }

      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Array<
        Record<string, unknown>
      >
      if (rows.length === 0) {
        report.push(`  ${table.padEnd(34)} — empty`)
        continue
      }

      // Only columns both sides have. A column the target lacks is a model that moved on,
      // and copying into it is impossible; a column the source lacks takes its default.
      const columns = Object.keys(rows[0]!).filter(column =>
        destination.columns.has(column.toLowerCase()),
      )
      const dropped = Object.keys(rows[0]!).length - columns.length

      const { rows: existing } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "${destination.name}"`,
      )
      if (Number(existing[0]?.count ?? 0) > 0 && !force) {
        throw new Error(
          `${destination.name} already holds ${existing[0]?.count} rows. Refusing to copy on ` +
            'top of them — empty the target, or pass --force if that is really what you want.',
        )
      }

      report.push(
        `  ${table.padEnd(34)} ${String(rows.length).padStart(7)} rows` +
          (dropped > 0 ? `  (${dropped} column(s) not in the target)` : ''),
      )
      copied += rows.length
      if (dryRun) continue

      const quoted = columns.map(column => `"${column}"`).join(', ')
      for (let at = 0; at < rows.length; at += BATCH) {
        const batch = rows.slice(at, at + BATCH)
        const values: unknown[] = []
        const tuples = batch.map(row => {
          const placeholders = columns.map(column => {
            values.push(coerce(row[column], destination.columns.get(column.toLowerCase())))
            return `$${values.length}`
          })
          return `(${placeholders.join(', ')})`
        })
        await client.query(
          `INSERT INTO "${destination.name}" (${quoted}) VALUES ${tuples.join(', ')}`,
          values,
        )
      }
    }

    console.log(dryRun ? 'Would copy:' : 'Copied:')
    for (const line of report) console.log(line)
    console.log(
      `\n${dryRun ? 'would copy' : 'copied'} ${copied} rows across ` +
        `${tables.length - skipped} tables` +
        (skipped > 0 ? `, skipped ${skipped}` : ''),
    )

    if (!dryRun) {
      // Verify by reading back rather than by trusting the insert. A count that disagrees is
      // the one thing worth failing loudly over, because everything downstream — a statement,
      // a payment run, a year of memories — is a sum over these rows.
      let wrong = 0
      for (const table of tables) {
        const destination = target.get(table.toLowerCase())
        if (destination === undefined) continue
        const here = (sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number })
          .n
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "${destination.name}"`,
        )
        const there = Number(rows[0]?.count ?? 0)
        if (here !== there) {
          console.error(`  MISMATCH ${table}: ${here} here, ${there} there`)
          wrong += 1
        }
      }
      if (wrong > 0) throw new Error(`${wrong} table(s) do not match. Do not switch over.`)
      console.log('every table matches, row for row')
    }
  } finally {
    await client.end()
    sqlite.close()
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

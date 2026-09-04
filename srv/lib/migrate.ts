/**
 * Bring an existing database up to the current model, in place.
 *
 * ## Why this exists
 *
 * `cds deploy` builds a database from nothing: it drops every table and recreates it.
 * That is exactly right for development and for tests, and exactly wrong for the one
 * database that matters — the SQLite file on the Fly volume, which holds the household's
 * real receipts, photographs and moods. Deploying TWM-ADR-002 phase 0 without this took
 * the API down with `no such column: $P.group_ID`, because the image shipped a model the
 * volume had never heard of. Nothing was lost, but nothing worked either.
 *
 * So: additive migrations, applied at boot, idempotent. Every step first asks whether it
 * has already happened. Running this against a current database does nothing and says so.
 *
 * ## What it will and will not do
 *
 * It creates missing tables and adds missing columns. It never drops a table, never drops
 * a column, and never rewrites a row that already has a value. A migration that can only
 * add is a migration that can be run on a Friday.
 *
 * SQLite's `ALTER TABLE ... ADD COLUMN` cannot add a column with a non-constant default,
 * which is why every column added here is nullable and backfilled by a separate `UPDATE`
 * rather than declared `NOT NULL DEFAULT`.
 *
 * ## Two stores
 *
 * Since ADR-003 this runs against SQLite *or* Postgres (`srv/lib/database.ts`). Two things
 * here cannot be dialect-blind, and both branch once, in the open:
 *
 * - **Reading the schema.** SQLite has `sqlite_master` and `PRAGMA table_info`; Postgres has
 *   `information_schema`, and folds unquoted identifiers to lower case. Neither knows the
 *   other, so `readSchema` answers for both and `hasTable`/`hasColumn` hide the casing.
 * - **Creating a table.** The DDL is no longer written out in this file: it is generated from
 *   the model, for whichever dialect is configured. That is both how it stays right on two
 *   stores and how it stopped being a second, drifting copy of `db/schema.cds` — the
 *   hand-written blocks that used to live here said `NVARCHAR` and `TIMESTAMP_TEXT`, which
 *   are SQLite spellings that Postgres rejects outright.
 *
 * Everything else is portable by construction: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ...
 * ADD COLUMN`, `CREATE INDEX IF NOT EXISTS` and `VARCHAR` mean the same on both.
 *
 * ## Adding to it later
 *
 * Append a step to {@link STEPS}. Each is `{ id, run }`, and `id` is recorded in
 * `twm_migrations` so it is applied once per database. Keep them additive; if a step ever
 * genuinely needs to destroy something, that is a different function with a different
 * name and a backup taken first.
 */
import cds from '@sap/cds'

import { databaseKind, type DatabaseKind } from './database'

const LOG = cds.log('migrate')

/** The household entities that gained a group in TWM-ADR-002 phase 0. */
const TENANT_TABLES = [
  'twowaymatch_Expenses',
  'twowaymatch_Receipts',
  'twowaymatch_People',
  'twowaymatch_Events',
  'twowaymatch_EventParticipants',
  'twowaymatch_EventPhotos',
  'twowaymatch_Reminders',
  'twowaymatch_Memories',
  'twowaymatch_Photos',
  'twowaymatch_Moods',
  'twowaymatch_Settlements',
  'twowaymatch_Statements',
  'twowaymatch_Corrections',
] as const

/**
 * The seeded household, matching `db/data/twowaymatch-Groups.csv`.
 *
 * A database that predates groups holds exactly one household's data, so everything in
 * it belongs here.
 */
const DEFAULT_GROUP = 'g0000000-0000-4000-8000-000000000001'

/**
 * DDL for the tables phase 0 introduced, copied verbatim from
 * `npx cds compile db --to sql` so the shapes cannot drift from the model.
 */
const NEW_TABLES: readonly string[] = [
  'twowaymatch_Groups',
  'twowaymatch_Users',
  'twowaymatch_Memberships',
  'twowaymatch_Conversations',
  'twowaymatch_Messages',
]

/** What a migration step needs from the database. Deliberately tiny. */
export interface MigrationDb {
  run(query: string): Promise<unknown>
  get?(query: string): Promise<unknown>
}

interface Step {
  id: string
  /**
   * Run on every boot rather than once.
   *
   * For steps whose whole body is `IF NOT EXISTS` and which therefore cost nothing to
   * repeat. Indexes are the case that matters: they get *appended to* over time, and a
   * once-only index step silently stops applying the moment its id is recorded — so a new
   * index added to an existing list would never reach any database that had already booted.
   * That is not hypothetical; it is what happened to the ADR-004 indexes, which include the
   * unique constraint that closes a double-spend race. Nothing here may assume a fresh
   * database, so the fix belongs in the runner.
   */
  always?: boolean
  run(db: MigrationDb, has: SchemaFacts, ddl: TableDdl): Promise<string[]>
}

/** `CREATE TABLE` for one table, in the configured dialect, or null if the model has no such table. */
type TableDdl = (table: string) => string | null

interface SchemaFacts {
  tables: Set<string>
  columns: Map<string, Set<string>>
  kind: DatabaseKind
}

/** Case-insensitive, because Postgres lower-cases every unquoted identifier CAP hands it. */
function hasTable(has: SchemaFacts, table: string): boolean {
  return has.tables.has(has.kind === 'postgres' ? table.toLowerCase() : table)
}

function hasColumn(has: SchemaFacts, table: string, column: string): boolean {
  const lower = has.kind === 'postgres'
  return (
    has.columns
      .get(lower ? table.toLowerCase() : table)
      ?.has(lower ? column.toLowerCase() : column) === true
  )
}

/**
 * Creates whichever of `tables` this database is missing, from the model.
 *
 * A table the model no longer has is skipped rather than failing the boot: a migration step
 * naming an entity that was since renamed should be a no-op, not an outage.
 */
async function createMissing(
  db: MigrationDb,
  has: SchemaFacts,
  ddl: TableDdl,
  tables: readonly string[],
): Promise<string[]> {
  const done: string[] = []
  for (const table of tables) {
    if (hasTable(has, table)) continue
    const create = ddl(table)
    if (create === null) {
      LOG.warn(`no DDL for ${table} in the current model; skipping`)
      continue
    }
    await db.run(create)
    done.push(`created ${table}`)
  }
  return done
}

async function readSchema(db: MigrationDb, kind: DatabaseKind): Promise<SchemaFacts> {
  if (kind === 'postgres') {
    // One query for both facts, lower-cased throughout: a lookup for `twowaymatch_Expenses`
    // would otherwise miss `twowaymatch_expenses` and the migration would cheerfully try to
    // create a table that already holds a household's receipts.
    const found = (await db.run(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()`,
    )) as Array<{ table_name?: string; column_name?: string }>
    const tables = new Set<string>()
    const columns = new Map<string, Set<string>>()
    for (const row of found ?? []) {
      const table = String(row.table_name).toLowerCase()
      tables.add(table)
      const names = columns.get(table) ?? new Set<string>()
      names.add(String(row.column_name).toLowerCase())
      columns.set(table, names)
    }
    return { tables, columns, kind }
  }

  const rows = (await db.run(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )) as Array<{ name?: string }>
  const tables = new Set((rows ?? []).map(row => String(row.name)))
  const columns = new Map<string, Set<string>>()
  for (const table of tables) {
    const info = (await db.run(`PRAGMA table_info(${table})`)) as Array<{ name?: string }>
    columns.set(table, new Set((info ?? []).map(row => String(row.name))))
  }
  return { tables, columns, kind }
}

/**
 * `CREATE TABLE` statements for the current model, in the current dialect, by table name.
 *
 * The *source* model, not `cds.model`, for the same reason `refreshViews` uses it: the
 * runtime model has already had its associations flattened into foreign keys, and asking the
 * SQL backend to flatten them again fails. Built once per `migrate()` call, and only when a
 * step actually needs it.
 */
async function tableDdl(kind: DatabaseKind): Promise<TableDdl> {
  const compiler = cds.compile as unknown as {
    to: { sql(model: unknown, options?: { dialect?: string }): string | string[] }
  }
  let statements: string[] = []
  try {
    // The dialect is passed rather than inherited. `cds.compile.to.sql` will happily read it
    // from ambient configuration and get it wrong — it emitted `NVARCHAR` and
    // `TIMESTAMP_TEXT` for a Postgres database in test, which are SQLite spellings Postgres
    // rejects, and that DDL would have run at boot against the real store.
    const produced = compiler.to.sql(await cds.load(['db', 'srv']), { dialect: kind })
    statements = (Array.isArray(produced) ? produced : String(produced).split(';')).map(one =>
      String(one).trim(),
    )
  } catch (error) {
    LOG.warn('could not generate table DDL from the model', describe(error))
  }
  const byTable = new Map<string, string>()
  for (const statement of statements) {
    const named = /^CREATE TABLE\s+"?([\w.]+)"?/i.exec(statement)
    if (named !== null) byTable.set(named[1]!.toLowerCase(), statement)
  }
  return (table: string) => byTable.get(table.toLowerCase()) ?? null
}

/**
 * Touch maps (CONTRACTS.md §13). Added after the volume already held a household, so
 * like every other table here these are created in place rather than by `cds deploy`,
 * which would take the existing rows with it.
 *
 * `group_ID` is spelled out rather than left to the phase-0 loop: that loop adds the
 * column to tables it finds, and these two do not exist when it runs.
 */
const TOUCH_MAP_TABLES: readonly string[] = ['twowaymatch_BodyMaps', 'twowaymatch_BodyZones']

/** The corpus from ADR-003, absent from every database that predates it. */
const COMMONS_TABLES: readonly string[] = [
  'twowaymatch_Places',
  'twowaymatch_PlaceRatings',
  'twowaymatch_PlaceRatingTags',
  'twowaymatch_PlaceStats',
  'twowaymatch_PlaceTagCounts',
  'twowaymatch_Ideas',
]

/**
 * The indexes the commons needs to be fast, and the one it needs to be correct.
 *
 * `CREATE INDEX IF NOT EXISTS` and `CREATE UNIQUE INDEX IF NOT EXISTS` mean the same thing on
 * SQLite and on Postgres, so these need no dialect branch.
 *
 * The unique one is not an optimisation. "One household, one voice" (CONTRACTS §14.3) is
 * enforced in `CommonsService` by reading the existing rating before writing, which is a
 * check-then-act and therefore a race: two taps on a slow connection can interleave between
 * the read and the insert and leave a household with two votes on one place, silently
 * doubling its weight in the ranking. The index closes it in the only place it can be closed.
 */
const COMMONS_INDEXES: ReadonlyArray<{ name: string; ddl: string }> = [
  {
    name: 'twm_place_ratings_one_per_household',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS twm_place_ratings_one_per_household
            ON twowaymatch_PlaceRatings (place_ID, authorKey)`,
  },
  {
    name: 'twm_place_ratings_author',
    ddl: `CREATE INDEX IF NOT EXISTS twm_place_ratings_author
            ON twowaymatch_PlaceRatings (authorKey)`,
  },
  {
    // The discovery index: cell, then kind, then rank. Every `nearby` and every `tonight`
    // is one range scan over this and nothing else.
    name: 'twm_place_stats_discovery',
    ddl: `CREATE INDEX IF NOT EXISTS twm_place_stats_discovery
            ON twowaymatch_PlaceStats (geohash6, kind, score DESC)`,
  },
  {
    name: 'twm_place_stats_place',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS twm_place_stats_place
            ON twowaymatch_PlaceStats (place_ID)`,
  },
  {
    name: 'twm_place_tag_counts_tag',
    ddl: `CREATE INDEX IF NOT EXISTS twm_place_tag_counts_tag
            ON twowaymatch_PlaceTagCounts (tag, count DESC)`,
  },
  {
    name: 'twm_places_cell',
    ddl: `CREATE INDEX IF NOT EXISTS twm_places_cell ON twowaymatch_Places (geohash6)`,
  },
  {
    // How two households adding the same restaurant land on one row.
    name: 'twm_places_osm',
    ddl: `CREATE INDEX IF NOT EXISTS twm_places_osm ON twowaymatch_Places (osmType, osmId)`,
  },
]

/** The card vault and the ledger from ADR-004, absent from every database that predates it. */
const MONEY_TABLES: readonly string[] = [
  'twowaymatch_PaymentMethods',
  'twowaymatch_CardSetups',
  'twowaymatch_LedgerTransfers',
  'twowaymatch_LedgerPostings',
  'twowaymatch_PointsAwards',
]

/**
 * The indexes the ledger needs to be fast, and the two it needs to be *correct*.
 *
 * The two unique ones are not optimisations, and they guard the same class of bug the
 * commons' one-vote index guards — a check-then-act race — with rather more at stake.
 *
 * `WalletService.post()` reads for an existing `idempotencyKey` and then inserts. Two
 * deliveries of one webhook, or two taps on a slow connection, can interleave between the
 * read and the insert and write the movement twice. In the commons that costs a household an
 * extra vote; here it mints points twice or moves money twice, and no amount of application
 * care closes it. The index does, in the only place it can be closed.
 *
 * `twm_points_awards_event` is the same argument for the award side: one act, one payment,
 * however many times the handler runs.
 *
 * The plain index on `(account, currency)` is the one every balance query in the app is
 * shaped like. Without it, "how many points has this household" is a full scan of every
 * posting ever written, which is fine on the first day and ruinous on the thousandth.
 */
const MONEY_INDEXES: ReadonlyArray<{ name: string; ddl: string }> = [
  {
    name: 'twm_ledger_transfers_idempotency',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS twm_ledger_transfers_idempotency
            ON twowaymatch_LedgerTransfers (idempotencyKey)`,
  },
  {
    name: 'twm_ledger_postings_account',
    ddl: `CREATE INDEX IF NOT EXISTS twm_ledger_postings_account
            ON twowaymatch_LedgerPostings (account, currency)`,
  },
  {
    name: 'twm_ledger_postings_transfer',
    ddl: `CREATE INDEX IF NOT EXISTS twm_ledger_postings_transfer
            ON twowaymatch_LedgerPostings (transfer_ID)`,
  },
  {
    name: 'twm_points_awards_event',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS twm_points_awards_event
            ON twowaymatch_PointsAwards (eventKey)`,
  },
  {
    // The daily-cap question: "how many of these has this household had today".
    name: 'twm_points_awards_cap',
    ddl: `CREATE INDEX IF NOT EXISTS twm_points_awards_cap
            ON twowaymatch_PointsAwards (group_ID, reason, onDate)`,
  },
  {
    name: 'twm_payment_methods_group',
    ddl: `CREATE INDEX IF NOT EXISTS twm_payment_methods_group
            ON twowaymatch_PaymentMethods (group_ID, removedAt)`,
  },
  {
    // How `finishCardSetup` finds the setup it is being asked about.
    name: 'twm_card_setups_ref',
    ddl: `CREATE INDEX IF NOT EXISTS twm_card_setups_ref
            ON twowaymatch_CardSetups (ref, group_ID)`,
  },
]

/**
 * The composite indexes ADR-002 §1 promised for the household tables and nobody ever built.
 *
 * Every tenant read is `WHERE group_ID = ?` and the two big ones then order by a date, so
 * these are the shape those queries actually want. Harmless on a one-household database and
 * the difference between a scan and a seek on a shared one.
 */
const TENANT_INDEXES: ReadonlyArray<{ name: string; ddl: string }> = [
  {
    name: 'twm_expenses_group_date',
    ddl: `CREATE INDEX IF NOT EXISTS twm_expenses_group_date
            ON twowaymatch_Expenses (group_ID, date)`,
  },
  {
    name: 'twm_events_group_start',
    ddl: `CREATE INDEX IF NOT EXISTS twm_events_group_start
            ON twowaymatch_Events (group_ID, startsOn)`,
  },
  {
    name: 'twm_messages_conversation',
    ddl: `CREATE INDEX IF NOT EXISTS twm_messages_conversation
            ON twowaymatch_Messages (conversation_ID, createdAt)`,
  },
]

const STEPS: ReadonlyArray<Step> = [
  {
    id: 'adr-002-phase-0-groups',
    async run(db, has, ddl) {
      const done: string[] = [...(await createMissing(db, has, ddl, NEW_TABLES))]

      for (const table of TENANT_TABLES) {
        if (!hasTable(has, table)) continue // an entity this database never had
        if (hasColumn(has, table, 'group_ID')) continue
        // VARCHAR, not NVARCHAR: SQLite accepts either and Postgres has no NVARCHAR at all.
        await db.run(`ALTER TABLE ${table} ADD COLUMN group_ID VARCHAR(36)`)
        done.push(`added ${table}.group_ID`)
      }

      // One household existed before groups did, so everything in this database is its.
      const groups = (await db.run(
        `SELECT ID FROM twowaymatch_Groups WHERE ID = '${DEFAULT_GROUP}'`,
      )) as unknown[]
      if ((groups ?? []).length === 0) {
        await db.run(
          `INSERT INTO twowaymatch_Groups (ID, name, kind, currency, isDefault)
           VALUES ('${DEFAULT_GROUP}', 'Our household', 'couple', 'CHF', TRUE)`,
        )
        done.push('seeded the default household')
      }

      for (const table of TENANT_TABLES) {
        if (!hasTable(has, table)) continue
        await db.run(`UPDATE ${table} SET group_ID = '${DEFAULT_GROUP}' WHERE group_ID IS NULL`)
      }
      done.push('assigned every existing row to it')
      return done
    },
  },
  {
    id: 'touch-maps',
    run: (db, has, ddl) => createMissing(db, has, ddl, TOUCH_MAP_TABLES),
  },
  {
    id: 'adr-003-commons',
    run: (db, has, ddl) => createMissing(db, has, ddl, COMMONS_TABLES),
  },
  {
    id: 'adr-004-money',
    run: (db, has, ddl) => createMissing(db, has, ddl, MONEY_TABLES),
  },
  {
    // Separate from the table step on purpose: an index can be added to a database that
    // already has the tables, and this step is re-run — and must be safe to re-run — every
    // time another index is appended to those lists. `always` is what actually makes that
    // true; without it the step stopped applying the moment its id was recorded, and the
    // ADR-004 indexes added later never reached a database that had booted before them.
    id: 'adr-003-indexes',
    always: true,
    async run(db, has) {
      const done: string[] = []
      for (const { name, ddl } of [...COMMONS_INDEXES, ...TENANT_INDEXES, ...MONEY_INDEXES]) {
        const table = /ON\s+(\w+)/i.exec(ddl)?.[1]
        if (table !== undefined && !hasTable(has, table)) continue
        try {
          await db.run(ddl)
          done.push(`indexed ${name}`)
        } catch (error) {
          // A unique index can legitimately fail on an existing database that already holds
          // the duplicates it forbids. That is worth a loud line in the log and is not worth
          // refusing to boot over: the application check still holds, and the alternative is
          // an outage over a row somebody wrote twice.
          LOG.warn(`could not create ${name}`, describe(error))
        }
      }
      return done
    },
  },
]

/**
 * Apply every step this database has not seen.
 *
 * Safe to call on every boot: the ledger table makes each step run once, and each step
 * is written to be harmless if it somehow runs twice anyway.
 */
export async function migrate(db: MigrationDb): Promise<string[]> {
  const kind = databaseKind()
  await db.run(
    // VARCHAR and TIMESTAMP rather than SQLite's NVARCHAR and TIMESTAMP_TEXT: this is the
    // first statement any database sees, and on Postgres the old spelling was a syntax error
    // before a single migration could run.
    `CREATE TABLE IF NOT EXISTS twm_migrations (
       id VARCHAR(100) NOT NULL,
       appliedAt TIMESTAMP,
       PRIMARY KEY(id)
     )`,
  )
  const applied = new Set(
    ((await db.run('SELECT id FROM twm_migrations')) as Array<{ id?: string }>).map(row =>
      String(row.id),
    ),
  )

  const notes: string[] = []
  let ddl: TableDdl | null = null
  for (const step of STEPS) {
    const seen = applied.has(step.id)
    if (seen && step.always !== true) continue
    const facts = await readSchema(db, kind)
    // Generated lazily and once: a database that is already current runs no steps and pays
    // nothing for the compiler.
    ddl ??= await tableDdl(kind)
    const done = await step.run(db, facts, ddl)

    // A step that has run before is being repeated on purpose (`always`), and its DDL is
    // all `IF NOT EXISTS` — so it changed nothing and must say nothing. Reporting it would
    // print a dozen "indexed ..." lines on every boot forever, which is how a log stops
    // being read.
    if (seen) continue

    await db.run(
      `INSERT INTO twm_migrations (id, appliedAt) VALUES ('${step.id}', '${new Date().toISOString()}')`,
    )
    for (const note of done) notes.push(`${step.id}: ${note}`)
  }

  if (notes.length === 0) LOG.info('database is current; nothing to migrate')
  else for (const note of notes) LOG.info(note)
  return notes
}

/**
 * Rebuild the service views so they match the model that is running.
 *
 * A CAP service projection becomes a SQL view, and a view's column list is frozen when
 * it is created. Adding `group_ID` to the base tables therefore fixed nothing on its
 * own: every query goes through `LedgerService_*`, and those still described the old
 * shape, so the API kept answering `no such column: $P.group_ID` while the column sat
 * there in the table underneath.
 *
 * Views hold no data, so dropping and recreating them costs nothing and cannot lose
 * anything. The DDL is generated from `cds.model` rather than written down here, which
 * means it cannot drift: whatever the running build's projections are, that is what the
 * database gets. Cheap enough to do on every boot, and self-healing if a deployment ever
 * lands with a model the volume has not seen.
 */
export async function refreshViews(db: MigrationDb): Promise<number> {
  const compiler = cds.compile as unknown as {
    to: { sql(model: unknown, options?: { dialect?: string }): string | string[] }
  }
  const kind = databaseKind()
  let produced: string | string[]
  try {
    // The *source* model, not `cds.model`. The runtime model has already had its
    // associations flattened into foreign keys, and asking the SQL backend to flatten
    // it again fails with "generated foreign key element group_ID conflicts with
    // existing element". Loading the .cds files gives the compiler what it expects --
    // and the image ships them, at /app/db and /app/srv.
    produced = compiler.to.sql(await cds.load(['db', 'srv']), { dialect: kind })
  } catch (error) {
    LOG.warn('could not generate view DDL; leaving the views alone', describe(error))
    return 0
  }

  const statements = (Array.isArray(produced) ? produced : String(produced).split(';'))
    .map(statement => String(statement).trim())
    .filter(statement => /^CREATE VIEW/i.test(statement))

  let rebuilt = 0
  for (const create of statements) {
    const named = /^CREATE VIEW\s+("?[\w.]+"?)/i.exec(create)
    if (named === null) continue
    const view = named[1]
    try {
      await db.run(`DROP VIEW IF EXISTS ${view}`)
      await db.run(create)
      rebuilt += 1
    } catch (error) {
      // One bad view must not stop the rest, and must not stop the server: the base
      // tables are correct by this point, and a stale view fails loudly per request.
      LOG.warn(`could not rebuild ${view}`, describe(error))
    }
  }
  if (rebuilt > 0) LOG.info(`rebuilt ${rebuilt} service views to match the running model`)
  return rebuilt
}

/** An unknown throwable, reduced to one safe line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

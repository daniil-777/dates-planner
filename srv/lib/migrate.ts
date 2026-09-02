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
 * ## Adding to it later
 *
 * Append a step to {@link STEPS}. Each is `{ id, run }`, and `id` is recorded in
 * `twm_migrations` so it is applied once per database. Keep them additive; if a step ever
 * genuinely needs to destroy something, that is a different function with a different
 * name and a backup taken first.
 */
import cds from '@sap/cds'

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
const NEW_TABLES: ReadonlyArray<{ table: string; ddl: string }> = [
  {
    table: 'twowaymatch_Groups',
    ddl: `CREATE TABLE twowaymatch_Groups (
  ID NVARCHAR(36) NOT NULL,
  createdAt TIMESTAMP_TEXT,
  createdBy NVARCHAR(255),
  modifiedAt TIMESTAMP_TEXT,
  modifiedBy NVARCHAR(255),
  name NVARCHAR(120),
  kind NVARCHAR(20) DEFAULT 'couple',
  currency NVARCHAR(3) DEFAULT 'CHF',
  isDefault BOOLEAN DEFAULT FALSE,
  inviteCode NVARCHAR(12),
  inviteExpiresAt TIMESTAMP_TEXT,
  PRIMARY KEY(ID)
)`,
  },
  {
    table: 'twowaymatch_Users',
    ddl: `CREATE TABLE twowaymatch_Users (
  ID NVARCHAR(36) NOT NULL,
  createdAt TIMESTAMP_TEXT,
  createdBy NVARCHAR(255),
  modifiedAt TIMESTAMP_TEXT,
  modifiedBy NVARCHAR(255),
  email NVARCHAR(200),
  passwordHash NVARCHAR(80),
  displayName NVARCHAR(100),
  gender NVARCHAR(40),
  PRIMARY KEY(ID)
)`,
  },
  {
    table: 'twowaymatch_Memberships',
    ddl: `CREATE TABLE twowaymatch_Memberships (
  ID NVARCHAR(36) NOT NULL,
  createdAt TIMESTAMP_TEXT,
  createdBy NVARCHAR(255),
  modifiedAt TIMESTAMP_TEXT,
  modifiedBy NVARCHAR(255),
  user_ID NVARCHAR(36),
  group_ID NVARCHAR(36),
  person_ID NVARCHAR(36),
  role NVARCHAR(10) DEFAULT 'member',
  PRIMARY KEY(ID)
)`,
  },
  {
    table: 'twowaymatch_Conversations',
    ddl: `CREATE TABLE twowaymatch_Conversations (
  ID NVARCHAR(36) NOT NULL,
  createdAt TIMESTAMP_TEXT,
  createdBy NVARCHAR(255),
  modifiedAt TIMESTAMP_TEXT,
  modifiedBy NVARCHAR(255),
  group_ID NVARCHAR(36),
  kind NVARCHAR(10) DEFAULT 'group',
  title NVARCHAR(120),
  PRIMARY KEY(ID)
)`,
  },
  {
    table: 'twowaymatch_Messages',
    ddl: `CREATE TABLE twowaymatch_Messages (
  ID NVARCHAR(36) NOT NULL,
  createdAt TIMESTAMP_TEXT,
  createdBy NVARCHAR(255),
  modifiedAt TIMESTAMP_TEXT,
  modifiedBy NVARCHAR(255),
  group_ID NVARCHAR(36),
  conversation_ID NVARCHAR(36),
  author_ID NVARCHAR(36),
  kind NVARCHAR(10) DEFAULT 'text',
  body NVARCHAR(4000),
  media LARGEBLOB,
  mediaType NVARCHAR(50),
  durationMs INTEGER,
  peaks NCLOB,
  PRIMARY KEY(ID)
)`,
  },
]

/** What a migration step needs from the database. Deliberately tiny. */
export interface MigrationDb {
  run(query: string): Promise<unknown>
  get?(query: string): Promise<unknown>
}

interface Step {
  id: string
  run(db: MigrationDb, has: SchemaFacts): Promise<string[]>
}

interface SchemaFacts {
  tables: Set<string>
  columns: Map<string, Set<string>>
}

async function readSchema(db: MigrationDb): Promise<SchemaFacts> {
  const rows = (await db.run(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )) as Array<{ name?: string }>
  const tables = new Set((rows ?? []).map(row => String(row.name)))
  const columns = new Map<string, Set<string>>()
  for (const table of tables) {
    const info = (await db.run(`PRAGMA table_info(${table})`)) as Array<{ name?: string }>
    columns.set(table, new Set((info ?? []).map(row => String(row.name))))
  }
  return { tables, columns }
}

const STEPS: ReadonlyArray<Step> = [
  {
    id: 'adr-002-phase-0-groups',
    async run(db, has) {
      const done: string[] = []

      for (const { table, ddl } of NEW_TABLES) {
        if (has.tables.has(table)) continue
        await db.run(ddl)
        done.push(`created ${table}`)
      }

      for (const table of TENANT_TABLES) {
        if (!has.tables.has(table)) continue // an entity this database never had
        if (has.columns.get(table)?.has('group_ID') === true) continue
        await db.run(`ALTER TABLE ${table} ADD COLUMN group_ID NVARCHAR(36)`)
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
        if (!has.tables.has(table)) continue
        await db.run(`UPDATE ${table} SET group_ID = '${DEFAULT_GROUP}' WHERE group_ID IS NULL`)
      }
      done.push('assigned every existing row to it')
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
  await db.run(
    `CREATE TABLE IF NOT EXISTS twm_migrations (
       id NVARCHAR(100) NOT NULL,
       appliedAt TIMESTAMP_TEXT,
       PRIMARY KEY(id)
     )`,
  )
  const applied = new Set(
    ((await db.run('SELECT id FROM twm_migrations')) as Array<{ id?: string }>).map(row =>
      String(row.id),
    ),
  )

  const notes: string[] = []
  for (const step of STEPS) {
    if (applied.has(step.id)) continue
    const facts = await readSchema(db)
    const done = await step.run(db, facts)
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
    to: { sql(model: unknown): string | string[] }
  }
  let produced: string | string[]
  try {
    // The *source* model, not `cds.model`. The runtime model has already had its
    // associations flattened into foreign keys, and asking the SQL backend to flatten
    // it again fails with "generated foreign key element group_ID conflicts with
    // existing element". Loading the .cds files gives the compiler what it expects --
    // and the image ships them, at /app/db and /app/srv.
    produced = compiler.to.sql(await cds.load(['db', 'srv']))
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

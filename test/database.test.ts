/**
 * Choosing a database, and migrating one — `srv/lib/database.ts` and `srv/lib/migrate.ts`.
 *
 * ## Why this file exists
 *
 * `migrate()` runs at boot against the one database that matters, and it had no tests. That
 * was survivable while it spoke one dialect and its DDL was written out by hand. It is not
 * survivable now: it speaks two, generates its DDL from the model, and the failure mode on
 * the wrong branch is an outage on somebody's phone rather than a red line here.
 *
 * The migration is driven through the deliberately tiny `MigrationDb` interface — `run` and
 * an optional `get` — so a fake that records SQL is a complete test double. Nothing here
 * needs a server, a file or a Postgres.
 *
 * ## What is asserted
 *
 * That the two dialects genuinely diverge where they must (`sqlite_master` versus
 * `information_schema`) and nowhere else; that no SQLite-only spelling can reach Postgres,
 * which is the specific bug that would take a Postgres deployment down on its first boot;
 * that a current database is left alone; and that Postgres's habit of lower-casing every
 * unquoted identifier cannot make the migration mistake a table it already has for one it
 * needs to create.
 */
import cds from '@sap/cds'
import { beforeEach, describe, expect, it } from 'vitest'

import { backupIsExternal, databaseKind, parsePostgresUrl } from '../srv/lib/database'
import { migrate } from '../srv/lib/migrate'

/** A database that records what it was asked and answers with whatever it was given. */
function fakeDb(answers: Array<(sql: string) => unknown | undefined> = []) {
  const sql: string[] = []
  return {
    sql,
    async run(query: string): Promise<unknown> {
      sql.push(query)
      for (const answer of answers) {
        const found = answer(query)
        if (found !== undefined) return found
      }
      return []
    },
  }
}

/** Answers the schema probe as an empty database of the given dialect. */
function emptySchema() {
  return [
    (sql: string) => (/information_schema/.test(sql) ? [] : undefined),
    (sql: string) => (/sqlite_master/.test(sql) ? [] : undefined),
    (sql: string) => (/PRAGMA/.test(sql) ? [] : undefined),
    (sql: string) => (/FROM twm_migrations/.test(sql) ? [] : undefined),
    (sql: string) => (/FROM twowaymatch_Groups/.test(sql) ? [] : undefined),
  ]
}

const ORIGINAL = cds.env.requires.db

function useDialect(kind: 'sqlite' | 'postgres'): void {
  cds.env.requires.db = { ...(ORIGINAL as object), kind } as typeof ORIGINAL
}

beforeEach(() => {
  cds.env.requires.db = ORIGINAL
})

describe('parsing DATABASE_URL', () => {
  it('takes apart an ordinary connection string', () => {
    const credentials = parsePostgresUrl('postgres://twm:hunter2@db.internal:5433/twm_production')
    expect(credentials).toMatchObject({
      host: 'db.internal',
      port: 5433,
      user: 'twm',
      password: 'hunter2',
      database: 'twm_production',
    })
  })

  it('survives a generated password, which is the whole reason it uses URL', () => {
    // A password with a slash and an at-sign is legal, common in generated credentials, and
    // the thing a regular expression gets wrong.
    const credentials = parsePostgresUrl('postgres://twm:p%2Fa%40ss%3Aword@host/db')
    expect(credentials.password).toBe('p/a@ss:word')
    expect(credentials.host).toBe('host')
    expect(credentials.database).toBe('db')
  })

  it('defaults the port, and accepts either spelling of the scheme', () => {
    expect(parsePostgresUrl('postgres://u:p@h/d').port).toBe(5432)
    expect(parsePostgresUrl('postgresql://u:p@h/d').database).toBe('d')
  })

  it('asks for TLS unless explicitly told not to', () => {
    expect(parsePostgresUrl('postgres://u:p@h/d').ssl).toEqual({ rejectUnauthorized: false })
    expect(parsePostgresUrl('postgres://u:p@h/d?sslmode=verify-full').ssl).toEqual({
      rejectUnauthorized: true,
    })
    // The escape hatch for a local Postgres with no certificate — and the only one.
    expect(parsePostgresUrl('postgres://u:p@h/d?sslmode=disable').ssl).toBeUndefined()
  })

  it('refuses anything it cannot be sure about, rather than falling back to SQLite', () => {
    expect(() => parsePostgresUrl('not a url')).toThrow(/not a URL/)
    expect(() => parsePostgresUrl('mysql://u:p@h/d')).toThrow(/postgres/)
    expect(() => parsePostgresUrl('postgres://u:p@h')).toThrow(/names no database/)
    expect(() => parsePostgresUrl('postgres://u:p@h/')).toThrow(/names no database/)
  })
})

describe('which database is in use', () => {
  it('is sqlite unless CAP has been pointed elsewhere', () => {
    expect(databaseKind()).toBe('sqlite')
    expect(backupIsExternal()).toBe(false)
  })

  it('reports postgres, and that its backups are somebody else’s job', () => {
    useDialect('postgres')
    expect(databaseKind()).toBe('postgres')
    // `scripts/backup.ts` snapshots a *file*. Run against Postgres it would produce a
    // reassuring empty tarball every night until the one night it was needed.
    expect(backupIsExternal()).toBe(true)
  })
})

describe('migrating', () => {
  it('reads the schema the way SQLite understands', async () => {
    useDialect('sqlite')
    // A table has to exist for the column probe to have anything to probe: SQLite answers
    // "what tables" and "what columns" with two different statements, one per table.
    const db = fakeDb([
      (sql: string) => (/sqlite_master/.test(sql) ? [{ name: 'twowaymatch_Expenses' }] : undefined),
      (sql: string) => (/PRAGMA/.test(sql) ? [{ name: 'ID' }] : undefined),
      (sql: string) => (/FROM twm_migrations/.test(sql) ? [] : undefined),
      (sql: string) => (/FROM twowaymatch_Groups/.test(sql) ? [] : undefined),
    ])
    await migrate(db)

    expect(db.sql.some(sql => /sqlite_master/.test(sql))).toBe(true)
    expect(db.sql).toContain('PRAGMA table_info(twowaymatch_Expenses)')
    expect(db.sql.some(sql => /information_schema/.test(sql))).toBe(false)
  })

  it('reads the schema the way Postgres understands', async () => {
    useDialect('postgres')
    const db = fakeDb(emptySchema())
    await migrate(db)

    expect(db.sql.some(sql => /information_schema\.columns/.test(sql))).toBe(true)
    expect(db.sql.some(sql => /sqlite_master/.test(sql))).toBe(false)
    expect(db.sql.some(sql => /PRAGMA/.test(sql))).toBe(false)
  })

  it('never sends a SQLite-only spelling to Postgres', async () => {
    useDialect('postgres')
    const db = fakeDb(emptySchema())
    await migrate(db)

    // This is the bug that would have taken a Postgres deployment down on its first boot,
    // before a single migration ran: `twm_migrations` was declared in SQLite's own types.
    for (const sql of db.sql) {
      expect(sql, `SQLite-only type in: ${sql.slice(0, 90)}`).not.toMatch(
        /NVARCHAR|TIMESTAMP_TEXT|AUTOINCREMENT/i,
      )
    }
  })

  it('creates its bookkeeping table in types both stores accept', async () => {
    for (const kind of ['sqlite', 'postgres'] as const) {
      useDialect(kind)
      const db = fakeDb(emptySchema())
      await migrate(db)
      const create = db.sql.find(sql => /CREATE TABLE IF NOT EXISTS twm_migrations/.test(sql))
      expect(create).toBeDefined()
      expect(create).toMatch(/VARCHAR\(100\)/)
      expect(create).toMatch(/TIMESTAMP\b/)
    }
  })

  it('adds a group column in a type Postgres has heard of', async () => {
    useDialect('postgres')
    const db = fakeDb([
      // Every tenant table exists, lower-cased as Postgres stores them, and none has a group.
      (sql: string) =>
        /information_schema/.test(sql)
          ? [
              { table_name: 'twowaymatch_expenses', column_name: 'id' },
              { table_name: 'twowaymatch_events', column_name: 'id' },
            ]
          : undefined,
      (sql: string) => (/FROM twm_migrations/.test(sql) ? [] : undefined),
      (sql: string) => (/FROM twowaymatch_Groups/.test(sql) ? [] : undefined),
    ])
    await migrate(db)

    const alters = db.sql.filter(sql => /ADD COLUMN group_ID/.test(sql))
    expect(alters.length).toBeGreaterThan(0)
    for (const alter of alters) expect(alter).toMatch(/VARCHAR\(36\)/)
  })

  it('does not try to create a table Postgres already lower-cased', async () => {
    useDialect('postgres')
    const db = fakeDb([
      (sql: string) =>
        /information_schema/.test(sql)
          ? [{ table_name: 'twowaymatch_bodymaps', column_name: 'id' }]
          : undefined,
      (sql: string) => (/FROM twm_migrations/.test(sql) ? [] : undefined),
      (sql: string) => (/FROM twowaymatch_Groups/.test(sql) ? [] : undefined),
    ])
    await migrate(db)

    // The casing trap: matched case-sensitively, `twowaymatch_BodyMaps` looks absent, and the
    // migration would try to create a table that already holds somebody's answers.
    expect(db.sql.some(sql => /CREATE TABLE .*BodyMaps/i.test(sql))).toBe(false)
  })

  it('builds the index that makes one household one voice', async () => {
    useDialect('postgres')
    const db = fakeDb([
      (sql: string) =>
        /information_schema/.test(sql)
          ? [{ table_name: 'twowaymatch_placeratings', column_name: 'id' }]
          : undefined,
      (sql: string) => (/FROM twm_migrations/.test(sql) ? [] : undefined),
      (sql: string) => (/FROM twowaymatch_Groups/.test(sql) ? [] : undefined),
    ])
    await migrate(db)

    // The application check in CommonsService is a check-then-act, so this index is what
    // actually stops two taps on a slow connection giving one household two votes.
    const unique = db.sql.find(sql => /twm_place_ratings_one_per_household/.test(sql))
    expect(unique).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/)
    expect(unique).toMatch(/place_ID, authorKey/)
  })

  it('skips an index whose table this database has never had', async () => {
    useDialect('sqlite')
    const db = fakeDb(emptySchema())
    await migrate(db)
    // Nothing exists, so nothing is indexed — an index on a missing table is an error, and
    // an error at boot is an outage.
    expect(db.sql.some(sql => /CREATE INDEX/i.test(sql))).toBe(false)
  })

  it('records each step once, so a second boot is a no-op', async () => {
    useDialect('sqlite')
    const applied = fakeDb([
      (sql: string) =>
        /FROM twm_migrations/.test(sql)
          ? [
              { id: 'adr-002-phase-0-groups' },
              { id: 'touch-maps' },
              { id: 'adr-003-commons' },
              { id: 'adr-003-indexes' },
              { id: 'adr-004-money' },
              { id: 'reflections' },
            ]
          : undefined,
    ])
    const notes = await migrate(applied)

    expect(notes).toEqual([])
    // Nothing is created, nothing is altered, and nothing is said.
    //
    // One read of the schema is the whole cost, and it is new: the index step is marked
    // `always` so that an index appended to its list reaches a database that has already
    // booted — which is exactly what failed to happen for the ADR-004 indexes, one of which
    // is the unique constraint closing a double-write race. Forcing that step to run means
    // asking the database what it has. It then creates nothing, because everything it would
    // create is `IF NOT EXISTS` against tables this fake reports it does not have.
    const rest = applied.sql.filter(sql => !/twm_migrations/.test(sql))
    expect(rest.every(sql => /^SELECT /i.test(sql.trim()))).toBe(true)
    expect(rest.some(sql => /CREATE TABLE|ALTER TABLE/i.test(sql))).toBe(false)
  })
})

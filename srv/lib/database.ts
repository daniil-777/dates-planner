/**
 * Which database this process talks to, and how it was told — CONTRACTS.md §15.
 *
 * ## Why there are two, and why that is not a hedge
 *
 * SQLite is right for development and for tests: a file, or nothing at all in memory, that
 * a test can drop and rebuild between cases in milliseconds. It is also right for a single
 * household in production — a ledger of a few thousand receipts on one volume is not a
 * database problem.
 *
 * The commons (ADR-003) is a different shape of thing: one table read by everybody, written
 * by everybody, and expected to grow past what one file on one machine can serve while that
 * machine is also serving the app. That is what Postgres is for, and ADR-002 already named
 * it as the destination.
 *
 * So the rule is: **the dialect is configuration, never a fork in the code.** Every query in
 * this repo is CQN, which CAP compiles for whichever store is configured; nothing above this
 * file knows which one it is. The two places that genuinely cannot be dialect-blind —
 * reading a schema, and creating an index — ask {@link databaseKind} and branch once, in the
 * open, with a comment.
 *
 * ## How it is chosen
 *
 * `DATABASE_URL` decides. Set, and this is Postgres; unset, and it is SQLite. There is no
 * third setting and no way to be half-configured: a malformed `DATABASE_URL` is a startup
 * failure, not a silent fall back to a SQLite file that would then quietly accumulate rows
 * nobody was expecting to keep.
 */
import cds from '@sap/cds'

export type DatabaseKind = 'sqlite' | 'postgres'

export interface PostgresCredentials {
  host: string
  port: number
  user: string
  password: string
  database: string
  /** Fly's Postgres speaks TLS; a local one usually does not. */
  ssl?: { rejectUnauthorized: boolean }
}

/**
 * Parses a `postgres://` connection string.
 *
 * Hand-parsed rather than handed to the driver, for two reasons that have both bitten
 * people: a password containing a `/` or an `@` is legal and common in a generated
 * credential, and `URL` decodes those correctly where a regular expression does not; and
 * the shape CAP wants is a credentials *object*, so the string has to be taken apart
 * somewhere regardless. Doing it here means it is done once and can be tested without a
 * database.
 */
export function parsePostgresUrl(value: string): PostgresCredentials {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('DATABASE_URL is not a URL.')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL must be a postgres:// URL, not ${url.protocol}//`)
  }
  const database = url.pathname.replace(/^\//, '')
  if (database.length === 0) throw new Error('DATABASE_URL names no database.')

  // `sslmode=disable` is the escape hatch for a local Postgres with no certificate. Anything
  // else — including saying nothing — gets TLS, because the alternative is a household's
  // ledger crossing a network in clear text because a query parameter was forgotten.
  const mode = url.searchParams.get('sslmode')
  const ssl = mode === 'disable' ? undefined : { rejectUnauthorized: mode === 'verify-full' }

  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ...(ssl === undefined ? {} : { ssl }),
  }
}

/** What this process is actually connected to. Read from CAP's own configuration, never guessed. */
export function databaseKind(): DatabaseKind {
  const kind = (cds.env?.requires?.db as { kind?: string } | undefined)?.kind
  return kind === 'postgres' ? 'postgres' : 'sqlite'
}

/**
 * Points CAP at Postgres when `DATABASE_URL` is set, and leaves it alone when it is not.
 *
 * Called from `bootstrap`, before anything connects. It writes `cds.env` rather than
 * relying on `package.json` profiles because the credentials come from the environment at
 * run time — Fly injects `DATABASE_URL` into the machine, and a profile in a committed file
 * cannot contain a password.
 */
export function configureDatabase(env: NodeJS.ProcessEnv = process.env): DatabaseKind {
  const url = env.DATABASE_URL?.trim()
  if (url === undefined || url.length === 0) return 'sqlite'

  const credentials = parsePostgresUrl(url)
  const requires = cds.env.requires as Record<string, unknown>
  requires.db = {
    kind: 'postgres',
    impl: '@cap-js/postgres',
    credentials,
  }
  return 'postgres'
}

/**
 * `true` when this database keeps its own backups.
 *
 * The nightly job in `.github/workflows/backup.yml` snapshots the SQLite file through
 * SQLite's online backup API, which is exactly the right thing to do to a file and exactly
 * the wrong thing to do to a managed Postgres — it would produce nothing, nightly, and
 * nobody would notice until the day it was needed. Managed Postgres takes its own backups;
 * `scripts/backup.ts` checks this and refuses rather than writing a reassuring empty
 * tarball.
 */
export function backupIsExternal(): boolean {
  return databaseKind() === 'postgres'
}

/// <reference types="@cap-js/cds-types" />
/**
 * The security properties this app cannot be allowed to lose quietly.
 *
 * 1. A phone photo's EXIF — GPS coordinates, camera serial, capture time — never reaches
 *    the database.
 * 2. An over-sized upload is refused by the transport, not by libvips running out of RAM.
 * 3. `/health` answers a monitoring probe without handing it a credential, and the CSP and
 *    the same-origin lock are on the response.
 * 4. `scripts/hash-password.ts` prints a hash that `bcrypt.compare` actually accepts.
 * 5. In production the server either authenticates every request or refuses to start.
 *
 * Every one of these is asserted end to end rather than by reading a constant: the EXIF
 * test builds a real JPEG with real metadata and inspects the output bytes, the HTTP tests
 * run against a listening socket, and the password and production-auth tests spawn real
 * processes.
 *
 * The express app under test is assembled with `configureApp` instead of by booting CAP.
 * That is deliberate — these assertions must keep working, and keep failing for the right
 * reason, on a day when a service handler somewhere else in `srv/` does not compile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import cds from '@sap/cds'
import express from 'express'
import sharp from 'sharp'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, request as httpRequest, type Server } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'
import { ImageError, MAX_UPLOAD_BYTES, processReceiptImage } from '../srv/lib/images'
import { configureApp } from '../srv/server'
import { readTarEntries, type BackupManifest } from '../scripts/backup'

/** Strings that must not show up in anything the server says out loud. */
const SECRETS: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'sk-ant-LEAK-CANARY-anthropic-0000000000',
  LLM_API_KEY: 'LEAK-CANARY-openai-1111111111',
  DOCAI_CLIENT_SECRET: 'LEAK-CANARY-docai-2222222222',
  CLASSIFIER_TOKEN: 'LEAK-CANARY-classifier-3333333333',
  AICORE_SERVICE_KEY: 'LEAK-CANARY-aicore-4444444444',
  HANA_PASSWORD: 'LEAK-CANARY-hana-5555555555',
  AUTH_HASH_A: '$2b$12$LEAKCANARYaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  AUTH_HASH_B: '$2b$12$LEAKCANARYbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
}

/** EXIF values chosen so that finding them in the output is unambiguous. */
const EXIF_CANARIES = [
  'TWM-CANARY-CAMERA-MAKE',
  'TWM-CANARY-CAMERA-MODEL',
  'TWM-CANARY-OWNER',
  '2026:03:14 20:15:00',
] as const

/** The tsx CLI, spawned the way `npm run hash` spawns it. */
const tsxCli = join(cds.root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

let server: Server
let origin: string
const savedEnv = new Map<string, string | undefined>()

beforeAll(async () => {
  for (const [name, value] of Object.entries(SECRETS)) {
    savedEnv.set(name, process.env[name])
    process.env[name] = value
  }

  const app = express()
  configureApp(app)
  server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await new Promise<void>(resolve => server.close(() => resolve()))
})

/* ------------------------------------------------------------------ *
 *  1. EXIF
 * ------------------------------------------------------------------ */

describe('receipt images', () => {
  it('strips every trace of EXIF from an uploaded photo', async () => {
    const withExif = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 210, g: 190, b: 170 } },
    })
      .withExif({
        IFD0: {
          Make: EXIF_CANARIES[0],
          Model: EXIF_CANARIES[1],
          Copyright: EXIF_CANARIES[2],
          Artist: EXIF_CANARIES[2],
        },
        IFD2: { DateTimeOriginal: EXIF_CANARIES[3] },
        // A phone geotags every photo. This is the tag that must not survive a private
        // ledger: it says where the two of them had dinner, to about ten metres.
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '47/1 22/1 0/1',
          GPSLongitudeRef: 'E',
          GPSLongitude: '8/1 32/1 0/1',
        },
      })
      .jpeg()
      .toBuffer()

    // The fixture is only worth anything if the metadata really went in.
    const before = await sharp(withExif).metadata()
    expect(
      before.exif,
      'the fixture itself carries no EXIF — the test proves nothing',
    ).toBeDefined()
    for (const canary of EXIF_CANARIES) {
      expect(withExif.includes(Buffer.from(canary, 'utf8'))).toBe(true)
    }

    const processed = await processReceiptImage(withExif, 'image/jpeg')

    const after = await sharp(processed.buffer).metadata()
    expect(after.exif).toBeUndefined()
    expect(after.xmp).toBeUndefined()
    expect(after.iptc).toBeUndefined()

    // Belt and braces: not merely "sharp cannot parse it", but "the bytes are not there".
    expect(processed.buffer.includes(Buffer.from('Exif\u0000\u0000', 'latin1'))).toBe(false)
    for (const canary of EXIF_CANARIES) {
      expect(
        processed.buffer.includes(Buffer.from(canary, 'utf8')),
        `${canary} survived processReceiptImage`,
      ).toBe(false)
    }
  })

  it('refuses an image over the 10 MB ceiling instead of shrinking it', async () => {
    const tooBig = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41)

    await expect(processReceiptImage(tooBig, 'image/jpeg')).rejects.toBeInstanceOf(ImageError)
    await expect(processReceiptImage(tooBig, 'image/jpeg')).rejects.toMatchObject({
      code: 'too_large',
    })
  })
})

/* ------------------------------------------------------------------ *
 *  2. Request size
 * ------------------------------------------------------------------ */

describe('request size limits', () => {
  it('rejects an over-sized upload from the headers, before reading a byte', async () => {
    const response = await declareLength('/api/ledger/scanReceipt', 20 * 1024 * 1024)

    expect(response.status).toBe(413)
    expect(response.body).toContain('payload_too_large')
  })

  it('holds an ordinary JSON body to a far smaller limit than an upload', async () => {
    // Two megabytes is nothing for a receipt and far too much for an OData payload, which
    // is exactly the distinction the two limits exist to draw.
    const response = await declareLength('/api/ledger/Expenses', 2 * 1024 * 1024)

    expect(response.status).toBe(413)
  })

  it('lets a normal request past the guard', async () => {
    const response = await fetch(`${origin}/ledger/Expenses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ merchantRaw: 'MIGROS 6010', amount: 16.77 }),
    })

    // A 404, because no service is mounted on this bare app — the point is only that the
    // size guard did not fire.
    expect(response.status).not.toBe(413)
  })
})

/* ------------------------------------------------------------------ *
 *  3. /health
 * ------------------------------------------------------------------ */

describe('/health', () => {
  it('answers with what is running', async () => {
    const response = await fetch(`${origin}/health`)
    expect(response.status).toBe(200)

    const payload: unknown = await response.json()
    expect(payload).toMatchObject({
      status: 'ok',
      version: expect.any(String),
      uptime: expect.any(Number),
      llm: expect.any(String),
    })

    const { docai, model, build } = payload as { docai: unknown; model: unknown; build: unknown }
    expect(['live', 'mock']).toContain(docai)
    expect(model === null || typeof model === 'string').toBe(true)
    // The frontend build stamp, when `app/dist` has been built; null in a bare checkout.
    if (build !== null) {
      expect(build).toMatchObject({
        version: expect.any(String),
        commit: expect.any(String),
        builtAt: expect.any(String),
      })
    }
  })

  it('reports the frontend build stamp from app/dist, and null once it is gone', async () => {
    // CI runs this suite before `npm run build`, so the stamp is written here rather than
    // hoped for — this is the one test of the path `health()` actually reads. A developer's
    // real `build.json` is put back afterwards.
    const distDir = join(cds.root, 'app', 'dist')
    const stampPath = join(distDir, 'build.json')
    const hadDist = existsSync(distDir)
    const previous = existsSync(stampPath) ? readFileSync(stampPath) : null
    const stamp = { version: '9.9.9', commit: 'cafe123', builtAt: '2026-09-01T10:47:13.211Z' }
    try {
      mkdirSync(distDir, { recursive: true })
      writeFileSync(stampPath, JSON.stringify(stamp))
      const stamped = (await (await fetch(`${origin}/health`)).json()) as { build: unknown }
      expect(stamped.build).toEqual(stamp)

      rmSync(stampPath)
      const bare = (await (await fetch(`${origin}/health`)).json()) as { build: unknown }
      expect(bare.build).toBeNull()
    } finally {
      if (previous !== null) writeFileSync(stampPath, previous)
      else if (!hadDist) rmSync(distDir, { recursive: true, force: true })
    }
  })

  it('leaks no credential, with every secret in the environment set to a canary', async () => {
    const body = await (await fetch(`${origin}/health`)).text()

    for (const [name, value] of Object.entries(SECRETS)) {
      expect(body, `${name} leaked into /health`).not.toContain(value)
    }
    // The provider line names the *variable* a key came from, which is the whole point of
    // `describeProvider()` — so that assertion above must not be passing by accident.
    expect(body).toContain('ANTHROPIC_API_KEY')
  })

  it('is not cacheable', async () => {
    const response = await fetch(`${origin}/health`)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

/* ------------------------------------------------------------------ *
 *  4. Headers and origins
 * ------------------------------------------------------------------ */

describe('hardening', () => {
  it('sends a content security policy that locks scripts down and lets UI5 style itself', async () => {
    const csp = (await fetch(`${origin}/health`)).headers.get('content-security-policy')

    expect(csp).toBeTruthy()
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).not.toContain('unsafe-eval')
    // The one loosening UI5 web components genuinely need.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('refuses a request from a foreign origin', async () => {
    const response = await fetch(`${origin}/health`, {
      headers: { origin: 'https://receipts.example.com' },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers its own origin', async () => {
    const response = await fetch(`${origin}/health`, { headers: { origin } })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)
  })
})

/* ------------------------------------------------------------------ *
 *  5. hash-password
 * ------------------------------------------------------------------ */

describe('scripts/hash-password.ts', () => {
  it('prints a hash that bcrypt.compare accepts, and rejects anything else', async () => {
    const password = 'a shared pot of money, 2024'

    const { stdout } = await hashPassword(password)
    const hash = stdout.trim()

    expect(hash, `unexpected CLI output: ${stdout}`).toMatch(
      /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/,
    )
    await expect(bcrypt.compare(password, hash)).resolves.toBe(true)
    await expect(bcrypt.compare(`${password} `, hash)).resolves.toBe(false)
    await expect(bcrypt.compare('', hash)).resolves.toBe(false)
  })

  it('never prints the password back', async () => {
    const password = 'CANARY-PLAINTEXT-PASSWORD'

    const { stdout, stderr } = await hashPassword(password)

    expect(stdout).not.toContain(password)
    expect(stderr).not.toContain(password)
  })
})

/* ------------------------------------------------------------------ *
 *  6. Production basic auth
 * ------------------------------------------------------------------ */

/**
 * The production auth path, in a real production process.
 *
 * It cannot be exercised in this process: `srv/server.ts` decides whether to authenticate
 * at module-evaluation time, from `NODE_ENV`, and re-importing it here would leave the
 * ledger's auth chain rewired for whatever ran next. So each case starts a child that
 * evaluates the module under `NODE_ENV=production` and serves `configureApp` on an
 * ephemeral port.
 *
 * Doing it this way is not ceremony. The first version of this file called
 * `loadCredentials()` from the top of the module, above the `const`s it reads, and every
 * test here passed — because none of them evaluated the module in production, where the
 * server died on a temporal-dead-zone error before it bound a port. That class of bug is
 * only visible from outside the process.
 */
const password = 'the passphrase on the fridge'

// Cost 4 rather than the CLI's 12: these suites verify the wiring, not bcrypt, and the
// decoy hash the server builds at startup follows whatever cost it is given.
const authEnv = {
  AUTH_USER_A: 'partner-a@example.com',
  AUTH_HASH_A: bcrypt.hashSync(password, 4),
  AUTH_USER_B: 'partner-b@example.com',
  AUTH_HASH_B: bcrypt.hashSync(`${password} B`, 4),
}

describe('production basic auth', () => {
  it('refuses to start when the credentials are missing', async () => {
    const { code, output } = await runProduction({
      AUTH_USER_A: '',
      AUTH_HASH_A: '',
      AUTH_USER_B: '',
      AUTH_HASH_B: '',
    })

    expect(code).not.toBe(0)
    expect(output).toContain('refusing to start in production')
    expect(output).toContain('AUTH_USER_A')
  })

  it('refuses to start when a hash is not a bcrypt hash', async () => {
    const { code, output } = await runProduction({ ...authEnv, AUTH_HASH_B: 'hunter2' })

    expect(code).not.toBe(0)
    expect(output).toContain('AUTH_HASH_B is not a bcrypt hash')
  })

  it('challenges an anonymous request to any path, /health included', async () => {
    const server = await startProduction(authEnv)
    try {
      const response = await fetch(`${server.origin}/health`)

      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toMatch(/^Basic realm=/)
    } finally {
      server.stop()
    }
  })

  it('lets every configured login in, and nobody else', async () => {
    const server = await startProduction(authEnv)
    try {
      const asA = await fetch(`${server.origin}/health`, {
        headers: basic('partner-a@example.com', password),
      })
      expect(asA.status).toBe(200)

      const asB = await fetch(`${server.origin}/health`, {
        headers: basic('partner-b@example.com', `${password} B`),
      })
      expect(asB.status).toBe(200)

      const wrongPassword = await fetch(`${server.origin}/health`, {
        headers: basic('partner-a@example.com', 'not it'),
      })
      expect(wrongPassword.status).toBe(401)

      // A username nobody configured must look exactly like a wrong password.
      const unknownUser = await fetch(`${server.origin}/health`, {
        headers: basic('someone-else@example.com', password),
      })
      expect(unknownUser.status).toBe(401)

      // The logins are not interchangeable.
      const crossed = await fetch(`${server.origin}/health`, {
        headers: basic('partner-b@example.com', password),
      })
      expect(crossed.status).toBe(401)
    } finally {
      server.stop()
    }
  })

  it('takes as many logins as the environment names, not two', async () => {
    // The ledger has no fixed number of people in it (CONTRACTS §10), so neither has the
    // credential list: `AUTH_USER_A` and `AUTH_USER_B` are two ordinary slots, and a third
    // pair is a third login with no code change anywhere.
    const server = await startProduction({
      ...authEnv,
      AUTH_USER_C: 'guest@example.com',
      AUTH_HASH_C: bcrypt.hashSync(`${password} C`, 4),
    })
    try {
      const asC = await fetch(`${server.origin}/health`, {
        headers: basic('guest@example.com', `${password} C`),
      })
      expect(asC.status).toBe(200)

      // …and the first two still work, which is what makes the third one an addition
      // rather than a replacement.
      const asA = await fetch(`${server.origin}/health`, {
        headers: basic('partner-a@example.com', password),
      })
      expect(asA.status).toBe(200)
    } finally {
      server.stop()
    }
  })

  it('refuses to start when two slots share one login', async () => {
    const { code, output } = await runProduction({
      ...authEnv,
      AUTH_USER_B: authEnv.AUTH_USER_A,
    })

    expect(code).not.toBe(0)
    expect(output).toContain('repeats a login')
  })
})

/* ------------------------------------------------------------------ *
 *  7. The SPA mount, and what it must never let through
 * ------------------------------------------------------------------ */

/**
 * `configureApp` has to be the last word on a non-API GET.
 *
 * CAP mounts `express.static(cds.env.folders.app)` — the app **source** folder — after the
 * bootstrap phase, so any GET this file's handlers pass along with `next()` is answered
 * out of the repository: `app/package.json`, `app/vite.config.ts`, `app/src/*`, and every
 * file under `app/node_modules`. The child below reproduces exactly that arrangement,
 * because the property is about the *arrangement* and cannot be seen from inside the app.
 *
 * It holds either way round: with a build present the SPA fallback 404s a path that looks
 * like a file, and with no build at all the fallthrough is closed outright.
 */
describe('the SPA mount', () => {
  it('never lets a request reach CAP’s static handler over the app source folder', async () => {
    const server = await startProduction(authEnv, "app.use(express.static('app'))")
    const credentials = basic(authEnv.AUTH_USER_A, password)

    try {
      for (const path of [
        '/package.json',
        '/vite.config.ts',
        '/src/main.tsx',
        '/node_modules/react/package.json',
      ]) {
        const response = await fetch(`${server.origin}${path}`, { headers: credentials })
        expect(response.status, `${path} was served from the app source folder`).toBe(404)
      }

      // The API is untouched by the guard — a 404 everywhere would pass the loop above
      // while breaking the entire application.
      const health = await fetch(`${server.origin}/health`, { headers: credentials })
      expect(health.status).toBe(200)
    } finally {
      server.stop()
    }
  })
})

/* ------------------------------------------------------------------ *
 *  8. backup and restore
 * ------------------------------------------------------------------ */

const RECEIPT_ID = '11111111-1111-4111-8111-111111111111'
const PHOTO_ID = '22222222-2222-4222-8222-222222222222'

/**
 * `db/schema.cds`, compiled to the SQLite DDL `cds deploy` would run.
 *
 * `cds.compile.to.sql` is real, documented API that `@cap-js/cds-types` 0.19 declares
 * loosely, so the one call this file makes is narrowed here rather than reached for with
 * `any`. Compiled once and cached: it costs a few hundred milliseconds and never changes
 * within a run.
 */
let ddlCache: string[] | null = null

async function schemaDdl(): Promise<string[]> {
  if (ddlCache === null) {
    const model = await cds.load('db')
    ddlCache = cds.compile.to.sql(model) as unknown as string[]
  }
  return ddlCache
}

/**
 * A ledger of the shape `scripts/backup.ts` reads, in a temporary directory.
 *
 * The tables are the *real* ones: `db/schema.cds` compiled to SQLite DDL, exactly as
 * `cds deploy` would create them. Writing the fixture's own `CREATE TABLE`s instead would
 * be quicker and would quietly keep passing after the schema had moved on underneath the
 * backup script — which is the one failure this test exists to catch. The file is its own,
 * in a temporary directory, so nothing here depends on a `db.sqlite` another test left
 * lying around.
 */
function makeLedger(path: string, ddl: readonly string[], receipt: Buffer, photo: Buffer): void {
  const db = new DatabaseSync(path)
  try {
    // The journal mode @cap-js/sqlite runs in, and the reason a snapshot leaves a `-wal`
    // and a `-shm` beside it — which is half of what this test is here to notice.
    db.exec('PRAGMA journal_mode = WAL')
    for (const statement of ddl) db.exec(statement)
    db.exec("INSERT INTO twowaymatch_People (ID) VALUES ('a'), ('b')")
    db.exec("INSERT INTO twowaymatch_Expenses (ID) VALUES ('e1'), ('e2'), ('e3')")
    db.prepare('INSERT INTO twowaymatch_Receipts (ID, mediaType, image) VALUES (?, ?, ?)').run(
      RECEIPT_ID,
      'image/jpeg',
      receipt,
    )
    db.prepare('INSERT INTO twowaymatch_Photos (ID, mediaType, image) VALUES (?, ?, ?)').run(
      PHOTO_ID,
      'image/png',
      photo,
    )
  } finally {
    db.close()
  }
}

describe('scripts/backup.ts and scripts/restore.ts', () => {
  it('round-trips the ledger and its blobs, and leaves nothing else on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'twm-backup-'))
    try {
      const source = join(root, 'ledger.sqlite')
      const outDir = join(root, 'archives')
      const receipt = await sharp({
        create: { width: 16, height: 16, channels: 3, background: { r: 9, g: 8, b: 7 } },
      })
        .jpeg()
        .toBuffer()
      const photo = await sharp({
        create: { width: 12, height: 12, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .toBuffer()
      makeLedger(source, await schemaDdl(), receipt, photo)

      const written = await runScript('backup.ts', ['--out', outDir], source)
      expect(written.code, written.output).toBe(0)

      // The snapshot is a second, unencrypted copy of the whole ledger, and so are the
      // `-wal` and `-shm` SQLite writes beside it. Only the archive may survive.
      const produced = readdirSync(outDir)
      expect(produced, `left behind: ${produced.join(', ')}`).toHaveLength(1)
      expect(produced[0]).toMatch(/^twoway-match-.+\.tar\.gz$/)

      const archive = join(outDir, produced[0])
      const entries = new Map(
        readTarEntries(gunzipSync(readFileSync(archive))).map(entry => [entry.name, entry.data]),
      )

      const manifest = JSON.parse(
        (entries.get('manifest.json') ?? Buffer.alloc(0)).toString('utf8'),
      ) as BackupManifest
      expect(manifest.counts).toMatchObject({ People: 2, Expenses: 3, Receipts: 1, Photos: 1 })
      expect(entries.get('db.sqlite')).toBeDefined()

      // The plain-file copies are the whole point of images/: still readable in ten years,
      // byte for byte, by someone who does not have this repository.
      expect(entries.get(`images/receipts/${RECEIPT_ID}.jpg`)?.equals(receipt)).toBe(true)
      expect(entries.get(`images/photos/${PHOTO_ID}.png`)?.equals(photo)).toBe(true)

      // ---- and back again, over a database that is already there ----
      const target = join(root, 'restored.sqlite')
      const previous = Buffer.from('the database that was there before\n')
      const previousWal = Buffer.from('committed, but so far only in the write-ahead log\n')
      writeFileSync(target, previous)
      writeFileSync(`${target}-wal`, previousWal)

      const read = await runScript('restore.ts', [archive, '--force'], target)
      expect(read.code, read.output).toBe(0)
      expect(read.output).toContain('verified')

      const restored = new DatabaseSync(target, { readOnly: true })
      try {
        const counted = restored.prepare('SELECT count(*) AS n FROM twowaymatch_Expenses').get() as
          { n: number } | undefined
        expect(counted?.n).toBe(3)

        const blob = restored
          .prepare('SELECT image FROM twowaymatch_Receipts WHERE ID = ?')
          .get(RECEIPT_ID) as { image: Uint8Array } | undefined
        expect(blob && Buffer.from(blob.image).equals(receipt)).toBe(true)
      } finally {
        restored.close()
      }

      // The database it replaced is kept — and so is its write-ahead log, which in WAL
      // mode is where the newest committed transactions still are. Deleting that would
      // silently truncate the copy the script has just called "the previous database".
      const kept = readdirSync(root).filter(name => name.startsWith('restored.sqlite.replaced-'))
      const keptDb = kept.filter(name => !name.endsWith('-wal') && !name.endsWith('-shm'))
      expect(keptDb, `set aside: ${kept.join(', ')}`).toHaveLength(1)
      expect(readFileSync(join(root, keptDb[0])).equals(previous)).toBe(true)

      const keptWal = join(root, `${keptDb[0]}-wal`)
      expect(existsSync(keptWal), 'the set-aside database lost its write-ahead log').toBe(true)
      expect(readFileSync(keptWal).equals(previousWal)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const basic = (user: string, password: string): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`,
})

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

/**
 * Run `scripts/hash-password.ts` exactly as `npm run hash` would, feeding the password in
 * on stdin so nothing lands in an argument vector this test could later read back.
 */
function hashPassword(password: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, join(cds.root, 'scripts', 'hash-password.ts'), '--stdin'],
      { cwd: cds.root },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`hash-password.ts exited ${code}: ${stderr}`))
    })
    child.stdin.end(`${password}\n`)
  })
}

/**
 * Run one of the operational scripts against a database of this test's own choosing.
 *
 * `CDS_REQUIRES_DB_CREDENTIALS_URL` is CAP's own environment override for
 * `cds.requires.db.credentials.url`, which is exactly what `databaseFile()` reads — so the
 * scripts point at a temporary file without either of them learning anything about tests.
 */
function runScript(
  script: string,
  args: readonly string[],
  databaseUrl: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, join(cds.root, 'scripts', script), ...args], {
      cwd: cds.root,
      env: { ...process.env, CDS_REQUIRES_DB_CREDENTIALS_URL: databaseUrl },
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (output += chunk))
    child.stderr.on('data', (chunk: string) => (output += chunk))
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, output }))
  })
}

/**
 * Evaluate `srv/server.ts` in a fresh process with `NODE_ENV=production`, and serve it.
 *
 * `node --import tsx --input-type=module -e` rather than a temporary file on disk: the
 * eval's module resolution is anchored at the working directory, which is the project
 * root, so `express` and `./srv/server.ts` both resolve the way they do in the real
 * server. The child prints the port it bound and then stays up.
 */
function productionChild(env: Record<string, string>, behind = ''): ChildProcessWithoutNullStreams {
  const script = [
    "const express = (await import('express')).default",
    "const { createServer } = await import('node:http')",
    "const { configureApp } = await import('./srv/server.ts')",
    'const app = express()',
    'configureApp(app)',
    // Whatever CAP would mount after the bootstrap phase, for the tests that care what
    // `configureApp` lets through to it.
    behind,
    'const server = createServer(app)',
    "server.listen(0, '127.0.0.1', () => console.log('LISTENING=' + server.address().port))",
  ].join('\n')

  return spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    // `undefined` deletes a variable rather than setting it to the string "undefined",
    // which is what makes the "no credentials at all" case reachable from a test process
    // whose own environment is full of canaries.
    { cwd: cds.root, env: { ...process.env, NODE_ENV: 'production', ...env } },
  )
}

interface ProductionServer {
  origin: string
  stop: () => void
}

function startProduction(env: Record<string, string>, behind = ''): Promise<ProductionServer> {
  const child = productionChild(env, behind)

  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`the production server did not bind a port:\n${output}`))
    }, 20_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      const port = /^LISTENING=(\d+)$/m.exec(output)
      if (port === null) return
      clearTimeout(timer)
      resolve({
        origin: `http://127.0.0.1:${port[1]}`,
        stop: () => child.kill(),
      })
    })
    child.stderr.on('data', (chunk: string) => (output += chunk))
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      reject(new Error(`the production server exited ${code}:\n${output}`))
    })
  })
}

/** The same child, run to completion — for the cases where it is supposed to refuse. */
function runProduction(env: Record<string, string>): Promise<{ code: number; output: string }> {
  const child = productionChild(env)

  return new Promise((resolve, reject) => {
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (output += chunk))
    child.stderr.on('data', (chunk: string) => (output += chunk))
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, output }))
  })
}

/**
 * POST with a declared `Content-Length` and no body at all.
 *
 * `fetch` will not let a caller lie about the length, and streaming twenty real megabytes
 * into a socket to prove a header check would make this suite slow and flaky. Sending the
 * headers and nothing else asserts exactly the property that matters: the guard answers
 * from `Content-Length`, before a byte of the body is read.
 */
function declareLength(
  path: string,
  contentLength: number,
): Promise<{ status: number; body: string }> {
  const { port } = server.address() as { port: number }

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(contentLength),
        },
      },
      response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => (body += chunk))
        response.on('end', () => {
          request.destroy()
          resolve({ status: response.statusCode ?? 0, body })
        })
      },
    )
    request.on('error', error => {
      // The server answering and hanging up before the promised body arrived is the
      // expected outcome here, not a failure.
      if (!('code' in error) || error.code !== 'ECONNRESET') reject(error)
    })
    request.flushHeaders()
  })
}

// A missing tsx would make the two CLI tests fail with a confusing spawn error.
if (!existsSync(tsxCli)) throw new Error(`tsx is not installed at ${tsxCli}`)

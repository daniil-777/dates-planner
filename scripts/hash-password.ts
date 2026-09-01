/**
 * Turn a password into the bcrypt hash that goes into `AUTH_HASH_A` / `AUTH_HASH_B`.
 *
 *     npm run hash -- 'the password you chose'
 *     npm run hash                     # prompts, and does not echo what you type
 *     echo 'pw' | npx tsx scripts/hash-password.ts --stdin
 *
 * Nothing here touches the database, the network, or `.env`; it prints one line and
 * exits, and the plaintext never leaves the process. The interactive path turns the
 * terminal's echo off so the password does not end up in a screen recording, and the
 * argv path exists mainly for CI — with the caveat, printed on stderr, that an argument
 * is visible in `ps` and in the shell history.
 */
import bcrypt from 'bcryptjs'

/**
 * Cost factor.
 *
 * 12 is roughly a quarter of a second per verification on a 2024 laptop: slow enough
 * that a leaked hash is not worth grinding for a two-person expense app, fast enough
 * that the one login per session is imperceptible. Raise it and every request pays for
 * it; lower it and the hash stops being worth having.
 */
const ROUNDS = 12

/** bcrypt truncates at 72 bytes; silently hashing a prefix would be a lie. */
const MAX_PASSWORD_BYTES = 72

const MIN_PASSWORD_LENGTH = 8

/** Control characters the raw-mode prompt has to interpret itself. */
const END_OF_TEXT = '\u0003' // Ctrl-C
const END_OF_TRANSMISSION = '\u0004' // Ctrl-D
const BACKSPACE = '\u0008'
const DELETE = '\u007f'

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    usage()
    return
  }

  const fromStdin = args.includes('--stdin')
  const positional = args.filter(arg => arg !== '--stdin')

  const password = fromStdin
    ? await readStdin()
    : positional.length > 0
      ? positional.join(' ')
      : await promptSilently('Password: ')

  if (!fromStdin && positional.length > 0) {
    process.stderr.write(
      'note: a password passed as an argument is visible in `ps` and in your shell history\n',
    )
  }

  validate(password)

  const hash = await bcrypt.hash(password, ROUNDS)

  // The advice goes to stderr so that `npm run hash -- pw > hash.txt` captures the hash
  // and nothing else.
  process.stderr.write(`bcrypt, cost ${ROUNDS}. Put this in .env inside SINGLE quotes:\n`)
  process.stdout.write(`${hash}\n`)
}

function usage(): void {
  process.stdout.write(
    [
      'Usage: npx tsx scripts/hash-password.ts [password]',
      '',
      '  password    the password to hash. Omit it to be prompted without echo, which',
      '              is the only form that keeps it out of your shell history.',
      '  --stdin     read the password from stdin instead (for pipes and CI).',
      '',
      'Prints one bcrypt hash on stdout, for AUTH_HASH_A or AUTH_HASH_B.',
      'Quote it with SINGLE quotes in .env: a bcrypt hash contains $ signs that some',
      'dotenv parsers would otherwise try to expand.',
      '',
    ].join('\n'),
  )
}

function validate(password: string): void {
  if (password.length === 0) {
    throw new Error('no password given')
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new Error(
      `bcrypt only hashes the first ${MAX_PASSWORD_BYTES} bytes, and this password is ` +
        'longer — everything past that would be ignored at login. Shorten it.',
    )
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    // A warning rather than a refusal: it is your ledger and your threat model.
    process.stderr.write(
      `warning: ${password.length} characters is short for the only lock on the front door\n`,
    )
  }
}

/** Reads everything piped in, and strips exactly one trailing newline — what `echo` adds. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '')
}

/**
 * Prompt with the terminal's echo turned off.
 *
 * `readline` has no hidden-input mode, so this switches the tty to raw mode and
 * reassembles the line by hand. Raw mode is the only way to stop the terminal painting
 * the characters as they are typed; it also stops Ctrl-C arriving as SIGINT, which is
 * why the interrupt is honoured explicitly below. Without a tty — a pipe, a CI runner —
 * it falls back to a plain read, which is what `--stdin` does anyway.
 */
async function promptSilently(prompt: string): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) return await readStdin()

  process.stderr.write(prompt)
  input.setRawMode(true)
  input.resume()
  input.setEncoding('utf8')

  try {
    return await new Promise<string>((resolve, reject) => {
      let typed = ''
      const onData = (chunk: string): void => {
        for (const character of chunk) {
          if (character === '\n' || character === '\r' || character === END_OF_TRANSMISSION) {
            input.off('data', onData)
            process.stderr.write('\n')
            resolve(typed)
            return
          }
          if (character === END_OF_TEXT) {
            input.off('data', onData)
            process.stderr.write('\n')
            reject(new Error('cancelled'))
            return
          }
          if (character === DELETE || character === BACKSPACE) {
            typed = typed.slice(0, -1)
            continue
          }
          // Everything else below U+0020 is part of an escape sequence from an arrow or
          // a function key. Appending those would silently change the password.
          if (character >= ' ') typed += character
        }
      }
      input.on('data', onData)
    })
  } finally {
    input.setRawMode(false)
    input.pause()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

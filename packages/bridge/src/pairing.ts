import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * WO-015 T-015.12 — **loopback is not consent.**
 *
 * The bridge hands whatever attaches to it `local` trust, and `local` trust is what makes
 * destructive tools reachable at all (with `confirm: true`). `127.0.0.1` proves only that the peer
 * runs on this machine, and every process on this machine can dial it — so without a shared secret
 * the first thing to connect inherits the highest trust level Douze has. That is the whole reason
 * this file exists.
 *
 * The shape is deliberately the smallest that holds:
 *
 * 1. A bridge with no credential mints a short code and prints it **to stderr**, which reaches the
 *    human through their MCP client's log and reaches no socket.
 * 2. The extension presents that code on `hello`. Nothing else attaches.
 * 3. On success the bridge mints a 32-byte secret, hands it back on `welcome` for the extension to
 *    pin, and stores only its sha256 in a `0600` file — the same discipline `installToken()` used
 *    for the daemon's token (packages/douzed/src/paths.ts).
 * 4. Every later run reads that file and never prompts again.
 *
 * The code is short because a human retypes it into the extension; the credential it buys is not,
 * because nothing retypes that. `ATTEMPTS` closes the gap between the two — see below.
 */

/**
 * Crockford's alphabet minus the characters people transcribe wrongly (0/O, 1/I/L, U).
 * 8 characters is ~39 bits, which is only safe alongside the attempt cap below.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8

/**
 * Failed attachments allowed before this process refuses every socket for the rest of its life.
 *
 * This is what makes a 39-bit code safe on a port every local process can reach: at ten guesses
 * per process, brute force needs ~10^10 bridge restarts, and only the user's own MCP client can
 * restart a bridge. Without it the code alone would be guessable in an afternoon.
 */
export const ATTEMPTS = 10

/** Same directory every other Douze artefact lives in; DOUZE_HOME redirects it for tests. */
export const credentialFile = (): string =>
  join(process.env['DOUZE_HOME'] ?? join(homedir(), '.douze'), 'bridge.json')

export interface Credential {
  /** sha256 hex of the secret. The secret itself is never written down on this side. */
  secret_hash: string
  paired_at: string
}

/** `XXXX-XXXX`, grouped only so a human reading it out loud does not lose their place. */
export const mintCode = (): string => {
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) code += ALPHABET[randomInt(ALPHABET.length)]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** A code is compared by its characters, not its formatting: dashes, spaces and case are noise. */
const normalize = (value: string): string => value.toUpperCase().replaceAll(/[^0-9A-Z]/g, '')

export const codeMatches = (presented: string, expected: string): boolean =>
  equal(Buffer.from(normalize(presented)), Buffer.from(normalize(expected)))

export const mintSecret = (): string => randomBytes(32).toString('base64url')

export const secretMatches = (presented: string, credential: Credential): boolean =>
  equal(sha256(presented), Buffer.from(credential.secret_hash, 'hex'))

/** A missing, truncated or hand-edited file counts as unpaired, and the bridge prompts again. */
export const readCredential = (): Credential | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(credentialFile(), 'utf8'))
    const hash = (parsed as { secret_hash?: unknown }).secret_hash
    return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
      ? { secret_hash: hash, paired_at: String((parsed as { paired_at?: unknown }).paired_at ?? '') }
      : null
  } catch {
    return null
  }
}

/**
 * `mode` only applies when the file is created, so a re-pair over an existing file would keep
 * whatever permissions that one had — hence the explicit chmod, the same correction
 * `packages/cli/src/remote-bridge.ts` had to make for `relay.json`.
 */
export const writeCredential = (secret: string): Credential => {
  const credential: Credential = { secret_hash: sha256(secret).toString('hex'), paired_at: new Date().toISOString() }
  const path = credentialFile()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return credential
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/** timingSafeEqual throws on a length mismatch, which is itself an oracle if it escapes. */
const equal = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b)

import { createHash, randomBytes, randomInt } from 'node:crypto'
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
 * 2. Neither end presents a credential: they prove they hold one, over nonces both contributed and
 *    bound to this port. `@douze/shared`'s `bridge-handshake.ts` is that exchange, and it is shared
 *    with the extension precisely so the two cannot drift into disagreeing about what proves what.
 * 3. On a first pairing — once the extension has proved it holds the code — the bridge mints a
 *    32-byte secret, hands it back on `welcome` for the extension to pin, and stores only its
 *    sha256 in a `0600` file. That hash is also the HMAC key every later attach runs on, so the
 *    secret itself is written down nowhere and never travels the wire again.
 * 4. Every later run reads that file and never prompts again.
 *
 * The code is short because a human retypes it into the extension; the credential it buys is not,
 * because nothing retypes that. The gap between the two is closed by making each guess expensive
 * (PBKDF2), making the work non-reusable across installs (a per-process salt), and giving the code
 * a lifetime — not by the attempt cap, which only bounds guessing done at the bridge.
 */

/**
 * Crockford's alphabet minus the characters people transcribe wrongly (0/O, 1/I/L, U).
 *
 * 8 characters is ~39 bits, and what makes that safe is **not** the attempt cap below: the bridge
 * answers a challenge to anything that says hello, so one captured challenge is an offline oracle
 * and no cap on this process can slow a search that is not running against it. What pays for 39
 * bits is the cost of a candidate (600 000 PBKDF2 rounds), the per-process salt that stops one
 * table from being computed once and spent against every install, and the ten minutes the code
 * stays alive at all (`CODE_TTL_MS` in bridge.ts).
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8

/**
 * Wrong proofs allowed before this process refuses every socket for the rest of its life.
 *
 * This is the online bound and only the online bound: guessing the credential *at* the bridge costs
 * one of these per guess, so ten is all a guesser gets. It is deliberately not spent on peers that
 * merely take a challenge and leave — see `turnAway` in bridge.ts, where counting those would hand
 * any local process a ten-socket way to lock the user out of their own pairing.
 */
export const ATTEMPTS = 10

/** Same directory every other Douze artefact lives in; DOUZE_HOME redirects it for tests. */
export const credentialFile = (): string =>
  join(process.env['DOUZE_HOME'] ?? join(homedir(), '.douze'), 'bridge.json')

export interface Credential {
  /**
   * sha256 hex of the secret, and the HMAC key the handshake runs on. The secret itself is never
   * written down on this side, and after the pairing that minted it, never sent either.
   */
  secret_hash: string
  paired_at: string
}

/** `XXXX-XXXX`, grouped only so a human reading it out loud does not lose their place. */
export const mintCode = (): string => {
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) code += ALPHABET[randomInt(ALPHABET.length)]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export const mintSecret = (): string => randomBytes(32).toString('base64url')

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
 * whatever permissions that one had — hence the explicit chmod. This is the only credential Douze
 * writes to disk at all: the relay pairing lives in extension storage (`attach:relay`), so there is
 * no second file to keep in step with this one.
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

/**
 * WO-015 T-015.12 — **the loopback handshake**, shared by the two ends that must agree on it: the
 * bridge (`@douze/bridge`) and the extension's attachment client (`packages/extension/src/attach.ts`).
 *
 * Binding a loopback port is not privileged, so "I dialled 127.0.0.1 and I hold a secret" proves
 * nothing about who answered: any process running as the user can take 8913 and wait for the
 * extension's next 30-second alarm. So neither end discloses anything until the other has proved it
 * holds the credential, and the proof is a challenge-response over nonces both ends contributed:
 *
 * ```
 *  extension → hello        { extension_version, nonce: Ne }        (no credential material)
 *  bridge    → bridge.challenge { nonce: Nb, salt?, proof: P(bridge) }
 *  extension → bridge.proof     { proof: P(extension) }             (only if P(bridge) verified)
 *  bridge    → welcome      { heartbeat_ms, secret? }               (only if P(extension) verified)
 * ```
 *
 * `P(role) = HMAC-SHA256(K, "douze-bridge-v1|<role>|<port>|<Ne>|<Nb>|<salt>")`, hex.
 *
 * Three things that string buys:
 *
 * - **Both nonces**, fresh per socket, so a recorded transcript replays into a different `Nb` (and
 *   a different `Ne`) and verifies against neither end. Each socket runs the exchange once.
 * - **The role**, so a rogue cannot reflect the extension's own proof back at it.
 * - **The port**, which is what stops a relay: a rogue on 8913 that forwards to a real bridge on
 *   8912 gets a challenge bound to 8912, and the extension is verifying against 8913. Two TCP
 *   connections with nothing to bind them is otherwise exactly the hole mutual auth leaves open,
 *   and one listener per port on loopback is the binding that is already there.
 *
 * `K` differs by which credential is in play, and neither is ever on the wire:
 *
 * - **paired**: `K = sha256(secret)` — which is precisely what the bridge already stores in
 *   `~/.douze/bridge.json`, so the secret itself is written down nowhere and re-sent never.
 *   Nothing is stretched here: the secret is 32 random bytes, and the salt is the empty string.
 * - **first pairing**: `K = PBKDF2-SHA256(code, salt)`. The code is ~39 bits and the bridge answers
 *   a challenge to anything that says hello, so that challenge is an **offline oracle**: one
 *   captured `{port, Ne, Nb, salt, proof}` is enough to search the code at whatever rate the
 *   attacker's hardware allows, and no attempt cap on the bridge touches that. Three things pay for
 *   the short code, and the attempt cap is not among them:
 *   1. `PBKDF2_ITERATIONS`, which sets the price per candidate;
 *   2. the **salt**, fresh per bridge process, so that price is paid per target — one precomputed
 *      table cannot be built once and spent against every Douze install (ASVS 6.5.2, 11.4.4);
 *   3. the code's lifetime, minutes rather than forever (`CODE_TTL_MS` in `@douze/bridge`), which
 *      is the window the search has to finish inside (ASVS 6.5.5).
 */

/** T-015.11 — the ports a bridge walks, deliberately not douzed's 8787–8791. */
export const BRIDGE_PORT_RANGE = [8912, 8913, 8914, 8915, 8916] as const

/** Bumped if the transcript below ever changes shape, so two versions cannot half-agree. */
const LABEL = 'douze-bridge-v1'

/**
 * OWASP's Password Storage Cheat Sheet figure for PBKDF2-HMAC-SHA256, which is what ASVS 11.4.2 and
 * 11.4.4 mean by current guidance. 100–300 ms per handshake on both ends depending on the machine,
 * paid once per pairing and never again — every attach after the first runs on `secretHashKey`,
 * which stretches nothing.
 */
const PBKDF2_ITERATIONS = 600_000

export type HandshakeRole = 'bridge' | 'extension'

export interface Transcript {
  /** Which side is proving. A proof for one role never verifies as the other. */
  role: HandshakeRole
  /** The port the bridge is listening on and the extension dialled — the channel binding. */
  port: number
  extensionNonce: string
  bridgeNonce: string
  /**
   * The bridge's PBKDF2 salt for this process, `''` once paired. Required rather than optional so
   * neither end can quietly forget it and prove against a transcript the other did not build; it
   * is already an input to `K` on the code path, and being in the string too means a peer that
   * changes it in flight fails verification for two independent reasons instead of one.
   */
  salt: string
}

/** 32 bytes, base64url. Fresh per socket on both ends and never reused. */
export const mintNonce = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)))

/**
 * The PBKDF2 salt a bridge mints for its pairing code. Same 32 random bytes as a nonce and the same
 * validator, because that is exactly what a salt needs to be: it is not secret, it is not a
 * challenge, and its only job is to be different on every install. Minted per bridge PROCESS rather
 * than stored per install — the code it salts dies at the first pairing, so there is nothing left
 * for a later run to reuse it for.
 */
export const mintSalt = mintNonce

/** A nonce off the wire: the shape is fixed, so anything else is not one. */
export const isNonce = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]{43}$/.test(value)

/** A code is compared by its characters: dashes, spaces and case are how a human typed it, not it. */
const normalizeCode = (value: string): string => value.toUpperCase().replaceAll(/[^\dA-Z]/g, '')

/**
 * The key a first pairing runs on, stretched because the code it comes from is short and salted
 * because a short secret with a constant salt is one table away from being no secret at all.
 *
 * The salt arrives on `bridge.challenge`, unauthenticated, which is safe: a rogue that sends a salt
 * of its own only makes the extension derive a key that the rogue still cannot produce a proof for,
 * and the extension is verifying the bridge's proof before it sends anything back.
 */
export const codeKey = async (code: string, salt: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey('raw', utf8(normalizeCode(code)), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8(`${LABEL}|pairing|${salt}`), iterations: PBKDF2_ITERATIONS },
    material,
    256,
  )
  return hmacKey(new Uint8Array(bits))
}

/** The key every later attach runs on: `sha256(secret)`, which is what the bridge stores. */
export const secretHashKey = (secretHashHex: string): Promise<CryptoKey> => hmacKey(fromHex(secretHashHex))

/** The extension holds the secret; the bridge holds this. Same 32 bytes either way. */
export const sha256Hex = async (value: string): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(value))))

export const proof = async (key: CryptoKey, transcript: Transcript): Promise<string> => {
  // No field can contain the separator — role is a union, port is a number, and the nonces and the
  // salt are base64url — so there is exactly one way to read this string back.
  const { role, port, extensionNonce, bridgeNonce, salt } = transcript
  const message = `${LABEL}|${role}|${port}|${extensionNonce}|${bridgeNonce}|${salt}`
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(message))))
}

/**
 * Constant-time over the digest, and the same implementation on both ends so neither can be the
 * lenient one. Only the length — fixed at 64 hex characters — is compared in variable time.
 */
export const proofMatches = (expected: string, presented: unknown): boolean => {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false
  let differences = 0
  for (let index = 0; index < expected.length; index += 1) {
    differences |= expected.charCodeAt(index) ^ presented.charCodeAt(index)
  }
  return differences === 0
}

const hmacKey = (raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])

/** `Uint8Array.from` rather than the encoder's own output, which is not pinned to an ArrayBuffer. */
const utf8 = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(new TextEncoder().encode(value))

const hex = (bytes: Uint8Array<ArrayBuffer>): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const fromHex = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))

const base64url = (bytes: Uint8Array<ArrayBuffer>): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

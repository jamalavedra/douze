import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

/**
 * TR-3 — everything Douze persists lives under one directory the user owns.
 * DOUZE_HOME lets the E2E suite run against a scratch root without touching a real install.
 */
export const douzeHome = (): string => process.env['DOUZE_HOME'] ?? join(homedir(), '.douze')

export const paths = () => {
  const home = douzeHome()
  return {
    home,
    recipes: join(home, 'recipes'),
    fixtures: join(home, 'fixtures'),
    captures: join(home, 'captures.db'),
    audit: join(home, 'audit.jsonl'),
    runtime: join(home, 'douzed.json'),
    token: join(home, 'token'),
    extension: join(home, 'extension'),
  }
}

export function ensureHome(): ReturnType<typeof paths> {
  const p = paths()
  for (const dir of [p.home, p.recipes, p.fixtures]) mkdirSync(dir, { recursive: true })
  return p
}

/**
 * AC-EXE-001.1 / AC-CON-001.2 — one token per install, generated on first run. Every loopback
 * request carries it, so another local process cannot drive the relay.
 */
export function installToken(): string {
  const p = ensureHome()
  if (existsSync(p.token)) return readFileSync(p.token, 'utf8').trim()
  const token = randomBytes(24).toString('base64url')
  writeFileSync(p.token, token, { mode: 0o600 })
  return token
}

/** A Chrome extension id: 32 letters, a–p. Both an unpacked and a Web Store id look like this. */
const EXTENSION_ID = /^[a-p]{32}$/

/** The id inside a `chrome-extension://…` origin, or null when that is not what this is. */
export const extensionIdOf = (origin: string): string | null => {
  const id = origin.startsWith('chrome-extension://') ? origin.slice('chrome-extension://'.length) : ''
  return EXTENSION_ID.test(id) ? id : null
}

/**
 * Trust on first use — which extension may hold the install token.
 *
 * The Origin check on /pair keeps web pages out, but every other Chrome extension the user has
 * installed can send `Origin: chrome-extension://…` too, and one with loopback host access would
 * then hold a token that drives the relay on every site the user approved. Douze has no Web Store
 * id yet, so an allowlist is not available: the first extension to pair owns this install.
 *
 * A pin file that is not a well-formed id — a truncated write, a hand edit — counts as no pin.
 * Refusing everything would lock the user out of their own daemon over a file nobody knew existed.
 *
 * DOUZE_EXTENSION_ID forces the answer and is never written back: an unpacked extension's id
 * changes with its path, so the e2e suite and anyone reloading a local build need to say which.
 */
export function pinnedExtension(): string | null {
  const forced = process.env['DOUZE_EXTENSION_ID']
  if (forced) return forced
  try {
    const pinned = readFileSync(paths().extension, 'utf8').trim()
    return EXTENSION_ID.test(pinned) ? pinned : null
  } catch {
    return null
  }
}

/** Called only once pairing has actually succeeded, so a refused attempt never claims the pin. */
export function pinExtension(id: string): void {
  writeFileSync(ensureHome().extension, id, { mode: 0o600 })
}

export interface RuntimeInfo {
  pid: number
  port: number
  started_at: number
}

export const readRuntime = (): RuntimeInfo | null => {
  try {
    return JSON.parse(readFileSync(paths().runtime, 'utf8')) as RuntimeInfo
  } catch {
    return null
  }
}

export const writeRuntime = (info: RuntimeInfo): void => {
  writeFileSync(ensureHome().runtime, JSON.stringify(info))
}

/** AC-RUN-003.2 — a stale runtime file must not be mistaken for a live daemon. */
export function isAlive(info: RuntimeInfo | null): info is RuntimeInfo {
  if (!info) return false
  try {
    process.kill(info.pid, 0)
    return true
  } catch {
    return false
  }
}

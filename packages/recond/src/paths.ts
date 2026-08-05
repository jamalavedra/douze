import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

/**
 * TR-3 — everything Recon persists lives under one directory the user owns.
 * RECON_HOME lets the E2E suite run against a scratch root without touching a real install.
 */
export const reconHome = (): string => process.env['RECON_HOME'] ?? join(homedir(), '.recon')

export const paths = () => {
  const home = reconHome()
  return {
    home,
    recipes: join(home, 'recipes'),
    fixtures: join(home, 'fixtures'),
    captures: join(home, 'captures.db'),
    audit: join(home, 'audit.jsonl'),
    runtime: join(home, 'recond.json'),
    token: join(home, 'token'),
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

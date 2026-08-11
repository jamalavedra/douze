import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { Recipe } from '@douze/shared'
import { DEGRADED_NOTICE, executeHeadless, Keychain } from './headless.js'
import type { SurfaceTool } from './registry.js'

const PORT = 4187
const ORIGIN = `http://127.0.0.1:${PORT}`
/** A dedicated service name so tests never touch a real Douze keychain entry. */
const keychain = new Keychain('douze-headless-test')
const ACCOUNT = `test-${process.pid}`

let app: ChildProcess

const recipe = (overrides: Record<string, unknown> = {}) =>
  Recipe.parse({
    version: 1,
    name: 'orders',
    enabled: true,
    target: { base_url: ORIGIN },
    auth: { mode: 'headless', keychain_ref: ACCOUNT, ...overrides },
    tools: [],
  })

const surface = (): SurfaceTool => ({
  qualified_name: 'orders_list_orders',
  recipe: 'orders',
  base_url: ORIGIN,
  credential_source: [{ kind: 'cookie' }],
  degraded: false,
  tool: {
    name: 'list_orders',
    description: 'Lists orders.',
    side_effect: 'read',
    confidence: 0.9,
    observations: 3,
    approved: true,
    fixtures: ['x.json'],
    request: { method: 'GET', path: '/api/orders', input_schema: {}, headers: {} },
    response: { output_schema: {} },
    flags: {
      sparse: false,
      derived_name: false,
      unverified: false,
      degraded: false,
      user_edited: [],
      suggestions: {},
    },
  },
})

beforeAll(async () => {
  app = spawn('npx', ['tsx', join(import.meta.dirname, '../../../fixtures/server.ts')], {
    env: { ...process.env, FIXTURE_PORT: String(PORT) },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${ORIGIN}/__test/log`)).ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('fixture app did not start')
}, 30_000)

afterAll(async () => {
  await keychain.clear(ACCOUNT)
  app.kill()
})

describe('headless mode (REQ-EXE-004)', () => {
  it('stores the session in the keychain and keeps only a reference in config (AC-EXE-004.1)', async () => {
    await keychain.set(ACCOUNT, 'fixture_session=s3ssion-fixture-value')
    expect(await keychain.get(ACCOUNT)).toBe('fixture_session=s3ssion-fixture-value')

    // The recipe carries a reference, never a value — and the schema refuses credential shapes.
    const config = recipe()
    expect(config.auth.keychain_ref).toBe(ACCOUNT)
    expect(JSON.stringify(config)).not.toContain('s3ssion-fixture-value')
  })

  it('executes without a browser and announces the degraded path (AC-EXE-004.3 / COV_EXE_004.1)', async () => {
    await keychain.set(ACCOUNT, 'fixture_session=s3ssion-fixture-value')
    const result = await executeHeadless(surface(), recipe(), {}, keychain)

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ data: { orders: expect.any(Array) } })
    expect(result.notice).toBe(DEGRADED_NOTICE)
    expect(result.notice).toContain('degraded path')
  })

  it('refuses when headless was never explicitly enabled (no implicit fallback)', async () => {
    const browserRelay = Recipe.parse({
      version: 1,
      name: 'orders',
      enabled: true,
      target: { base_url: ORIGIN },
      tools: [],
    })
    await expect(executeHeadless(surface(), browserRelay, {}, keychain)).rejects.toThrow(/not enabled/)
  })

  it('clears a dead session and directs the user back to relay (AC-EXE-004.4 / COV_EXE_004.2)', async () => {
    await keychain.set(ACCOUNT, 'fixture_session=stale-and-invalid')
    // The refresh endpoint exists but cannot mint a working session for a bad cookie.
    const config = recipe({ refresh_endpoint: '/api/nope' })

    await expect(executeHeadless(surface(), config, {}, keychain)).rejects.toThrow(/browser relay is required/i)
    // The keychain entry is gone.
    expect(await keychain.get(ACCOUNT)).toBeNull()
  })

  it('reports session_expired when no session is stored at all', async () => {
    await keychain.clear(ACCOUNT)
    await expect(executeHeadless(surface(), recipe(), {}, keychain)).rejects.toThrow(/No stored session/)
  })
})

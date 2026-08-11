import { describe, expect, it, vi } from 'vitest'
import { DouzeError, type RelayRequest, type RelayResponse, type SideEffect } from '@douze/shared'
import {
  MAX_RESULT_BYTES,
  RateLimiter,
  attachedSurface,
  buildRequest,
  checkPolicy,
  classify,
  cutToBytes,
  gateResult,
  runToolCall,
  shapeResult,
  type AuditEntry,
} from './guards.js'
import type { SurfaceTool } from './recipes.js'

/**
 * WO-015 T-015.9 — the trust table, and everything else that has to happen before a call reaches a
 * tab. These are the guards the daemon used to hold; they have no home outside this module now, so
 * the tests are the same shape as douzed's and the CLI's were, run against the extension's copy.
 */

const tool = (
  name: string,
  sideEffect: SideEffect,
  extra: Partial<SurfaceTool> = {},
  request: Partial<SurfaceTool['tool']['request']> = {},
): SurfaceTool => ({
  qualified_name: `jira_${name}`,
  recipe: 'jira',
  base_url: 'https://jira.test',
  tool: {
    name,
    description: `${name} issues`,
    side_effect: sideEffect,
    confidence: 0.9,
    observations: 4,
    approved: true,
    request: { method: 'GET', path: `/${name}`, input_schema: { type: 'object', properties: {} }, headers: {}, ...request },
    response: { output_schema: {}, primary_payload_path: '$.data' },
    fixtures: [],
    flags: { sparse: false, derived_name: false, unverified: false, degraded: false, user_edited: [], suggestions: {} },
  },
  credential_source: [{ kind: 'cookie' }],
  degraded: false,
  ...extra,
})

const READ = tool(
  'list',
  'read',
  {},
  {
    input_schema: {
      type: 'object',
      properties: { customer_email: { type: 'string' }, limit: { type: 'integer' } },
    },
  },
)
const WRITE = tool(
  'create',
  'write',
  {},
  { method: 'POST', input_schema: { type: 'object', properties: { title: { type: 'string' } } } },
)
const DESTRUCTIVE = tool(
  'delete',
  'destructive',
  {},
  {
    method: 'DELETE',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['id', 'confirm'],
    },
  },
)
const SURFACE = [READ, WRITE, DESTRUCTIVE]

const names = (tools: { name: string }[]): string[] => tools.map((entry) => entry.name)

// --- the surface a host is offered ----------------------------------------

describe('surface filtering at push time (T-015.9)', () => {
  it('offers a remote host reads only until writes are opted into', () => {
    expect(names(attachedSurface(SURFACE, 'remote', false))).toEqual(['jira_list'])
    expect(names(attachedSurface(SURFACE, 'remote', true))).toEqual(['jira_list', 'jira_create'])
  })

  it('never pushes a destructive tool to a remote host, whatever the opt-in says', () => {
    expect(names(attachedSurface(SURFACE, 'remote', true))).not.toContain('jira_delete')
  })

  it('pushes everything to a local host', () => {
    expect(names(attachedSurface(SURFACE, 'local', false))).toEqual(['jira_list', 'jira_create', 'jira_delete'])
  })

  it('carries the side effect and the degradation into the description a client selects on', () => {
    const degraded = tool('list', 'read', { degraded: true, degraded_reason: 'the response shape moved' })
    const [pushed] = attachedSurface([degraded, DESTRUCTIVE], 'local', true)
    expect(pushed?.description).toContain('Currently degraded and will refuse to run: the response shape moved')
    expect(attachedSurface([DESTRUCTIVE], 'local', true)[0]?.description).toContain('requires confirm=true')
  })
})

// --- the same table, enforced at call time --------------------------------

const refusal = (run: () => void): DouzeError => {
  try {
    run()
  } catch (error) {
    return error as DouzeError
  }
  throw new Error('expected a refusal')
}

describe('call-time enforcement regardless of what was pushed (T-015.9)', () => {
  it('refuses a destructive tool on a remote host even carrying confirm', () => {
    const error = refusal(() => checkPolicy(DESTRUCTIVE, { confirm: true }, 'remote', true))
    expect(error.code).toBe('trust_refused')
    expect(error.message).toContain('no setting that turns it on')
  })

  it('refuses a remote write until it is opted into, then allows it', () => {
    expect(refusal(() => checkPolicy(WRITE, {}, 'remote', false)).code).toBe('trust_refused')
    expect(() => checkPolicy(WRITE, {}, 'remote', true)).not.toThrow()
  })

  it('requires confirm for a destructive tool locally, and runs it with one', () => {
    expect(refusal(() => checkPolicy(DESTRUCTIVE, { id: '7' }, 'local', true)).code).toBe('confirm_required')
    expect(() => checkPolicy(DESTRUCTIVE, { id: '7', confirm: true }, 'local', true)).not.toThrow()
  })

  it('lets a read through at either trust level', () => {
    expect(() => checkPolicy(READ, {}, 'remote', false)).not.toThrow()
    expect(() => checkPolicy(READ, {}, 'local', false)).not.toThrow()
  })

  it('refuses a parameter the recipe never recorded, rather than passing it on', () => {
    // Nothing here breaks the trust table; what it does is widen a recorded read into an
    // arbitrary parameterised call against the target, which `buildRequest` would happily issue.
    const error = refusal(() => checkPolicy(READ, { limit: 20, role: 'admin' }, 'remote', false))
    expect(error.code).toBe('invalid_arguments')
    expect(error.message).toContain('"role" is not a parameter of this tool')
    expect(error.message).toContain('jira.test')
  })

  it('refuses an argument of the wrong type, and a required one that is missing', () => {
    expect(refusal(() => checkPolicy(READ, { limit: '20' }, 'local', true)).message).toContain('limit must be integer')
    expect(refusal(() => checkPolicy(DESTRUCTIVE, { confirm: true }, 'local', true)).message).toContain(
      '"id" is required',
    )
  })

  it('checks nested objects, which is where a GraphQL tool takes its variables', () => {
    const graphql = tool(
      'search',
      'read',
      {},
      {
        input_schema: {
          type: 'object',
          properties: { filter: { type: 'object', properties: { state: { type: 'string' } } } },
        },
      },
    )
    expect(() => checkPolicy(graphql, { filter: { state: 'open' } }, 'remote', false)).not.toThrow()
    expect(refusal(() => checkPolicy(graphql, { filter: { admin: true } }, 'remote', false)).message).toContain(
      '"filter.admin" is not a parameter',
    )
  })

  it('lets the runtime arguments through whatever the schema says, and leaves a loose schema loose', () => {
    expect(() => checkPolicy(READ, { raw: true, confirm: true }, 'local', true)).not.toThrow()
    // Inference emits `{}` for a shape it could not pin down; a constraint invented here would
    // refuse calls the recording proves are fine.
    const loose = tool('search', 'read', {}, { input_schema: {} })
    expect(() => checkPolicy(loose, { anything: 1 }, 'remote', false)).not.toThrow()
  })

  it('exempts a page-filled parameter from the required check, because the caller cannot send it', () => {
    const entry = tool(
      'get',
      'read',
      {
        credential_source: [
          { kind: 'page_state', expression: 'localStorage.getItem("k")', param: 'project', prefix: '' },
        ],
      },
      {
        path: '/p/{project}/issues',
        input_schema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
      },
    )
    expect(() => checkPolicy(entry, {}, 'remote', false)).not.toThrow()
  })

  it('refuses a degraded tool by name before any policy question (AC-RUN-001.5)', () => {
    const broken = tool('list', 'read', { degraded: true, degraded_reason: 'fixture "jira/list.json" is missing' })
    const error = refusal(() => checkPolicy(broken, {}, 'local', true))
    expect(error.code).toBe('tool_degraded')
    expect(error.message).toContain('jira.test')
    expect(error.detail['change']).toContain('is missing')
  })
})

describe('session-expiry classification (AC-EXE-002.1)', () => {
  const response = (patch: Partial<RelayResponse>): RelayResponse => ({
    id: 'r',
    ok: true,
    headers: {},
    duration_ms: 3,
    redirected_to_login: false,
    ...patch,
  })

  it('reads 401, 403 and a login redirect as the same thing', () => {
    for (const patch of [{ status: 401 }, { status: 403 }, { status: 200, redirected_to_login: true }]) {
      const error = refusal(() => classify(READ, response(patch)))
      expect(error.code).toBe('session_expired')
      expect(error.message).toContain('signed out of jira.test')
    }
  })

  it('leaves an ordinary answer alone', () => {
    expect(() => classify(READ, response({ status: 200 }))).not.toThrow()
  })
})

// --- the rate limiter ------------------------------------------------------

describe('per-tool rate limiting under service-worker eviction (AC-EXE-003.1)', () => {
  it('queues an excess call rather than dropping it when the wait is short', async () => {
    vi.useFakeTimers()
    try {
      const limiter = new RateLimiter()
      const done: number[] = []
      const run = (n: number): Promise<void> =>
        limiter.run('jira_list', 2, async () => {
          done.push(n)
        })
      await run(1)
      await run(2)
      // 45s in, the window has 15s left to run — inside the bound, so the call waits it out.
      await vi.advanceTimersByTimeAsync(45_000)
      const third = run(3)
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toEqual([1, 2])
      await vi.advanceTimersByTimeAsync(15_000)
      await third
      expect(done).toEqual([1, 2, 3])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses rather than parking a call past a heartbeat, and says how long to wait', async () => {
    vi.useFakeTimers()
    try {
      // A 1 ms ceiling stands in for "longer than this worker can be trusted to stay alive".
      const limiter = new RateLimiter(1)
      await limiter.run('jira_list', 1, async () => undefined)
      const error = (await limiter.run('jira_list', 1, async () => undefined).catch((e: unknown) => e)) as DouzeError
      expect(error.code).toBe('rate_limited')
      expect(error.message).toMatch(/Try again in \d+ seconds/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives each tool its own queue, so a throttled tool never blocks another', async () => {
    const limiter = new RateLimiter()
    const order: string[] = []
    await Promise.all([
      limiter.run('a', 5, async () => void order.push('a')),
      limiter.run('b', 5, async () => void order.push('b')),
    ])
    expect(order.sort()).toEqual(['a', 'b'])
  })
})

// --- result shaping --------------------------------------------------------

describe('result shaping (REQ-RUN-004)', () => {
  it('trims to the recipe’s primary payload path', () => {
    expect(shapeResult({ data: { id: 7 }, meta: {} }, { primary_payload_path: '$.data' }).data).toEqual({ id: 7 })
  })

  it('returns the envelope and says so when the path has moved', () => {
    const shaped = shapeResult({ other: 1 }, { primary_payload_path: '$.data' })
    expect(shaped.data).toEqual({ other: 1 })
    expect(shaped.note).toContain('did not resolve')
  })

  it('skips the trim entirely for raw', () => {
    expect(shapeResult({ data: 1 }, { primary_payload_path: '$.data', raw: true }).data).toEqual({ data: 1 })
  })

  it('caps at 32 KB without ever going over, even mid-emoji (AC-RUN-004.2)', () => {
    const shaped = shapeResult({ data: '🙂'.repeat(20_000) }, { primary_payload_path: '$.data' })
    expect(shaped.truncated?.returned_bytes).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    expect(shaped.truncated?.untrimmed_bytes).toBeGreaterThan(MAX_RESULT_BYTES)
    // Cutting the bytes and decoding blind yields a U+FFFD that is itself 3 bytes long.
    expect(String(shaped.data)).not.toContain('�')
  })

  it('cuts to a UTF-8 boundary rather than to a byte count', () => {
    expect(cutToBytes('aé', 2)).toBe('a')
    expect(cutToBytes('abc', 10)).toBe('abc')
  })
})

// --- the result secret gate ------------------------------------------------

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

describe('the result secret gate (T-014.4, ported)', () => {
  const carrying = { content: [{ type: 'text', text: `{"session":"${JWT}"}` }] }

  it('refuses a result carrying a credential and names where it is', () => {
    const error = refusal(() => gateResult('jira_list', carrying, []))
    expect(error.message).toContain('$.content[0].text')
    expect(error.message).toContain('jira_list')
    expect(error.message).not.toContain(JWT)
  })

  it('lets the same result through once the tool is exempted', () => {
    expect(() => gateResult('jira_list', carrying, ['jira_list'])).not.toThrow()
  })

  it('leaves a clean result untouched', () => {
    expect(() => gateResult('jira_list', { content: [{ type: 'text', text: '{"id":"ABC-1"}' }] }, [])).not.toThrow()
  })
})

// --- building the request --------------------------------------------------

describe('buildRequest', () => {
  it('substitutes path parameters and puts the rest in the query for a GET', () => {
    const request = buildRequest(tool('get', 'read', {}, { path: '/issues/{key}' }), { key: 'ABC-1', expand: 'all' })
    expect(request.url).toBe('https://jira.test/issues/ABC-1?expand=all')
  })

  it('leaves a page-filled parameter in the URL for the executor to resolve', () => {
    const entry = tool(
      'get',
      'read',
      {
        credential_source: [
          { kind: 'page_state', expression: 'localStorage.getItem("k")', param: 'project', prefix: '' },
        ],
      },
      { path: '/p/{project}/issues' },
    )
    expect(buildRequest(entry, {}).url).toContain('%7Bproject%7D')
  })

  it('sends the remaining arguments as a JSON body on a write, minus confirm and raw', () => {
    const request = buildRequest(tool('create', 'write', {}, { method: 'POST', path: '/issues' }), {
      title: 'x',
      confirm: true,
      raw: true,
    })
    expect(request.body).toEqual({ title: 'x' })
    expect(request.headers['content-type']).toBe('application/json')
  })
})

// --- the whole path --------------------------------------------------------

const ok = (body: unknown): RelayResponse => ({
  id: 'r',
  ok: true,
  status: 200,
  headers: {},
  body,
  duration_ms: 5,
  redirected_to_login: false,
})

const deps = (
  execute: (request: RelayRequest) => Promise<RelayResponse>,
  patch: Partial<Parameters<typeof runToolCall>[1]> = {},
): Parameters<typeof runToolCall>[1] => ({
  surface: () => SURFACE,
  execute,
  limiter: new RateLimiter(),
  audit: () => undefined,
  allowWrites: false,
  exposed: [],
  ...patch,
})

const textOf = (outcome: { result?: unknown }): Record<string, unknown> =>
  JSON.parse((outcome.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>

describe('one inbound tool.call, end to end (T-015.9)', () => {
  it('runs a read and hands back the shaped payload', async () => {
    const outcome = await runToolCall({ name: 'jira_list', args: {}, trust: 'remote' }, deps(async () => ok({ data: [1, 2] })))
    expect(outcome.error).toBeUndefined()
    expect(textOf(outcome)).toMatchObject({ status: 200, data: [1, 2] })
  })

  it('refuses a destructive tool a lying host asked for, and never touches the network', async () => {
    let called = false
    const outcome = await runToolCall(
      { name: 'jira_delete', args: { confirm: true }, trust: 'remote' },
      deps(async () => {
        called = true
        return ok({})
      }),
    )
    expect(called).toBe(false)
    // Not `confirm_required`: no argument an agent can send puts this back, and a code that says
    // otherwise invites it to retry forever.
    expect(outcome.error?.code).toBe('trust_refused')
    expect(outcome.error?.retryable).toBe(false)
  })

  it('refuses a write remotely until opted in, then runs it', async () => {
    const call = { name: 'jira_create', args: {}, trust: 'remote' } as const
    expect((await runToolCall(call, deps(async () => ok({ data: 1 })))).error?.code).toBe('trust_refused')
    const allowed = await runToolCall(call, deps(async () => ok({ data: 1 }), { allowWrites: true }))
    expect(allowed.error).toBeUndefined()
  })

  it('refuses a result carrying a JWT, then passes once the tool is exempted', async () => {
    const leaking = deps(async () => ok({ data: { session: JWT } }))
    const refused = await runToolCall({ name: 'jira_list', args: {}, trust: 'remote' }, leaking)
    // The path names the field inside the payload, because the gate now reads the payload rather
    // than the serialised envelope it used to be handed.
    expect(refused.error?.message).toContain('$.session')
    expect(JSON.stringify(refused)).not.toContain(JWT)

    const exempted = await runToolCall(
      { name: 'jira_list', args: {}, trust: 'remote' },
      deps(async () => ok({ data: { session: JWT } }), { exposed: ['jira_list'] }),
    )
    expect(exempted.error).toBeUndefined()
    expect(JSON.stringify(exempted)).toContain(JWT)
  })

  it('returns a big clean result truncated, rather than withholding it', async () => {
    // 4000 rows of nothing secret. Gated after the cap, this came back `result_withheld` naming
    // `$.content[0].text`: the cut JSON no longer parsed, so the detector fell through to its
    // entropy rule and 32 KB of space-free JSON scores far above the threshold. The only escape
    // the message offered — exempting the tool — would have disabled the gate for it entirely.
    const rows = Array.from({ length: 4000 }, (_, index) => ({ id: index, name: `order-${index}` }))
    const outcome = await runToolCall({ name: 'jira_list', args: {}, trust: 'remote' }, deps(async () => ok({ data: rows })))

    expect(outcome.error).toBeUndefined()
    const payload = textOf(outcome)
    expect((payload['truncated'] as { returned_bytes: number }).returned_bytes).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    expect(String(payload['data'])).toContain('order-0')
  })

  it('still withholds a big result once a credential is anywhere in it', async () => {
    const rows = Array.from({ length: 4000 }, (_, index) => ({ id: index, name: `order-${index}` }))
    const outcome = await runToolCall(
      { name: 'jira_list', args: {}, trust: 'remote' },
      deps(async () => ok({ data: { rows, session: JWT } })),
    )
    expect(outcome.error?.code).toBe('result_withheld')
    expect(outcome.error?.message).toContain('$.session')
    expect(JSON.stringify(outcome)).not.toContain(JWT)
  })

  it('refuses an argument the tool never had before it reaches the network', async () => {
    let called = false
    const outcome = await runToolCall(
      { name: 'jira_list', args: { role: 'admin' }, trust: 'remote' },
      deps(async () => {
        called = true
        return ok({ data: [] })
      }),
    )
    expect(called).toBe(false)
    expect(outcome.error?.code).toBe('invalid_arguments')
    expect(outcome.error?.retryable).toBe(false)
  })

  it('names a timeout rather than leaving the host to notice one', async () => {
    vi.useFakeTimers()
    try {
      const pending = runToolCall(
        { name: 'jira_list', args: {}, trust: 'local' },
        deps(() => new Promise<RelayResponse>(() => undefined), { timeoutMs: 1000 }),
      )
      await vi.advanceTimersByTimeAsync(1500)
      const outcome = await pending
      expect(outcome.error?.code).toBe('timeout')
      expect(outcome.error?.retryable).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('audits every call with the tool, the trust level and how it ended', async () => {
    const entries: AuditEntry[] = []
    const record = { audit: (entry: AuditEntry) => void entries.push(entry) }
    const args = { customer_email: 'someone@example.test' }
    await runToolCall({ name: 'jira_list', args, trust: 'remote' }, deps(async () => ok({ data: 1 }), record))
    await runToolCall({ name: 'jira_delete', args: {}, trust: 'remote' }, deps(async () => ok({}), record))

    expect(entries.map((entry) => [entry.tool, entry.trust, entry.outcome])).toEqual([
      ['jira_list', 'remote', 'ok'],
      ['jira_delete', 'remote', 'trust_refused'],
    ])
    // Arguments are deliberately never recorded — see AuditLog.
    expect(JSON.stringify(entries)).not.toContain('example.test')
  })

  it('refuses a name that is not on the surface at all', async () => {
    const outcome = await runToolCall({ name: 'jira_nope', args: {}, trust: 'local' }, deps(async () => ok({})))
    expect(outcome.error?.message).toContain('no tool called "jira_nope"')
  })
})

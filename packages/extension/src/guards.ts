import { DouzeError, findSurvivingSecrets, type RelayRequest, type RelayResponse } from '@douze/shared'
import type { AttachedTool, ToolFailure, Trust } from '@douze/mcp-host'
import type { SurfaceTool } from './recipes.js'

/**
 * WO-015 T-015.9 — **every guard, in one place, before dispatch on every inbound path.**
 *
 * The relay and the bridge both stamp a `trust` on the `tool.call` they send and NEITHER enforces
 * policy: a pipe that grew policy would be a second copy of it. This module is its only home, and
 * the trust it reads is the one `attach.ts` derived from what it dialled — never the frame's.
 *
 * The trust table (TASKS.md, WO-015) is enforced twice, and both halves are required:
 *
 * | | `remote` | `local` |
 * |---|---|---|
 * | read | always | always |
 * | write | opt-in per attachment | always |
 * | destructive | never, no setting restores it | allowed, `confirm: true` required |
 * | result secret gate | enforced, `expose` to exempt | enforced, `expose` to exempt |
 *
 * `attachedSurface` filters at push time so a hosted client never sees a tool that would always be
 * refused; `checkPolicy` refuses at call time whatever was pushed, because a host that lies about
 * what it was sent must not get through. Filtering alone is a UI courtesy, not a control.
 */

/** AC-RUN-004.2 — the cap on a returned result, measured as UTF-8 JSON bytes. */
export const MAX_RESULT_BYTES = 32 * 1024

/**
 * Our own ceiling on one call.
 *
 * **What constrains it is the host, not the worker.** The MV3 service worker is not the limit:
 * `@douze/mcp-host` sends a `ping` every 20 s for as long as a call is outstanding, and every
 * inbound frame resets Chrome's 30 s idle timer, so the worker stays alive as long as the host is
 * waiting. The limit is `CALL_TIMEOUT_MS` in packages/mcp-host/src/host.ts (120 s): past that the
 * host has already answered the client `timeout` and thrown our `tool.result` away.
 *
 * So this sits just under it. A dashboard export that genuinely takes 2–4 minutes cannot be
 * reported through this host at any value set here — raising ours only swaps our named `timeout`,
 * which says which tool and how long, for the host's generic one. Making such a call possible is a
 * change to the host's ceiling first (another package), and this constant follows it, not the
 * other way round. `guards.test.ts` reads that constant out of the host's source and fails if the
 * two ever cross.
 *
 * The old CLI's 300 s (`DOUZE_CALL_CEILING_MS`) was configurable because the CLI *was* the client
 * and owned both ends of the wait; nothing in the extension owns the far end any more.
 */
export const DEFAULT_TIMEOUT_MS = 110_000

/**
 * The longest a call queued behind a per-tool rate limit will wait before it is refused instead.
 *
 * douzed waited out the whole window — up to 60 s — because a daemon has nowhere else to be. A
 * service worker does: Chrome evicts it after 30 s idle, and a call parked in a promise across an
 * eviction is not a delayed call, it is a lost one that the host can only report as a 120 s
 * timeout. One heartbeat window is survivable, because the host's own 20 s `ping` lands inside it
 * and resets the idle timer; past that the honest answer is a retryable `rate_limited` naming the
 * seconds to wait, which the caller can act on and an evicted worker cannot silently eat.
 */
export const RATE_WAIT_MAX_MS = 20_000

/** How many audit entries survive in storage. The popup shows the last handful. */
export const AUDIT_LIMIT = 100

/**
 * A refusal whose reason is not one of `RelayErrorCode`'s seven, and must not borrow one.
 *
 * `confirm_required` for a destructive tool on a remote host would tell an agent to retry with
 * `confirm: true`, and no argument it can ever send puts a destructive tool back on a remote
 * surface — that is the whole point of the rule. `ToolFailure.code` is deliberately free-form
 * (packages/mcp-host/src/protocol.ts) so a guard the extension grows can name itself.
 */
export class Refusal extends Error {
  constructor(
    readonly code:
      | 'trust_refused'
      | 'result_withheld'
      | 'unknown_tool'
      | 'invalid_arguments'
      | 'permission_required'
      | 'executor_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'Refusal'
  }
}

/** One recorded call. Arguments are deliberately absent — see `AuditLog.record`. */
export interface AuditEntry {
  at: string
  tool: string
  trust: Trust
  /** `ok`, or the refusal code — the same string the caller was given. */
  outcome: string
  duration_ms: number
  status?: number
}

// --- the surface ----------------------------------------------------------

/**
 * A chat client selects on the description alone (ADR-008), so the side effect and the degradation
 * reason belong in the text and not only in annotations a client may ignore. Ported verbatim from
 * the CLI's `describe()` so a tool reads the same through either pipe.
 */
export function describe(entry: SurfaceTool): string {
  const parts = [entry.tool.description]
  if (entry.tool.side_effect === 'destructive') parts.push('Destructive: requires confirm=true.')
  if (entry.degraded) {
    parts.push(`Currently degraded and will refuse to run: ${entry.degraded_reason ?? 'contract drift'}.`)
  }
  return parts.join(' ')
}

/**
 * Whether this attachment may be *offered* the tool at all. Reads always; writes on opt-in when
 * remote; destructive only locally — no setting puts a destructive tool on a remote surface,
 * because a relay operator or a stolen URL can forge a `confirm` argument and consent UX is not
 * authentication.
 */
export const offerable = (
  sideEffect: SurfaceTool['tool']['side_effect'],
  trust: Trust,
  allowWrites: boolean,
): boolean => {
  if (trust === 'local') return true
  if (sideEffect === 'read') return true
  return sideEffect === 'write' && allowWrites
}

/** T-015.9 — the surface as one attachment sees it, filtered by its own trust level. */
export const attachedSurface = (
  tools: readonly SurfaceTool[],
  trust: Trust,
  allowWrites: boolean,
): AttachedTool[] =>
  tools
    .filter((entry) => offerable(entry.tool.side_effect, trust, allowWrites))
    .map((entry) => ({
      name: entry.qualified_name,
      description: describe(entry),
      input_schema: entry.tool.request.input_schema as Record<string, unknown>,
      side_effect: entry.tool.side_effect,
    }))

// --- call-time policy ------------------------------------------------------

/**
 * The guards that must fire before any network request is issued, whatever was pushed.
 *
 * Order matters only in what the caller is told first, and "this tool is broken" outranks "you may
 * not call it": a degraded tool is a fault to fix, and reporting a policy refusal for it would
 * send the user looking for a setting that would not help.
 */
export function checkPolicy(
  entry: SurfaceTool,
  args: Record<string, unknown>,
  trust: Trust,
  allowWrites: boolean,
): void {
  const name = entry.qualified_name
  if (entry.degraded) {
    // The assistant reads this out to whoever asked, so it is written for them: what happened,
    // that nothing ran, and the one thing that fixes it.
    throw new DouzeError(
      'tool_degraded',
      `"${name}" stopped working because ${siteOf(entry.base_url)} changed how it works. Douze did not ` +
        `run it. To fix it, open the site in Chrome, click the Douze button, and record it again.`,
      { tool: name, change: entry.degraded_reason },
    )
  }
  const effect = entry.tool.side_effect
  if (trust === 'remote' && effect === 'destructive') {
    throw new Refusal(
      'trust_refused',
      `"${name}" deletes or destroys something, and Douze never runs that for a hosted assistant — ` +
        `there is no setting that turns it on. Run it from an app on this computer instead.`,
    )
  }
  if (trust === 'remote' && effect === 'write' && !allowWrites) {
    throw new Refusal(
      'trust_refused',
      `"${name}" changes something on ${siteOf(entry.base_url)}, and this hosted assistant has ` +
        `read-only access. Open the Douze extension and allow changes for it if you meant to.`,
    )
  }
  if (effect === 'destructive' && args['confirm'] !== true) {
    throw new DouzeError(
      'confirm_required',
      `Tool "${name}" performs a destructive action. Re-run it with confirm=true to proceed.`,
      { tool: name },
    )
  }
  validateArgs(entry, args)
}

// --- argument validation ---------------------------------------------------

/**
 * Arguments the runtime owns rather than the recipe: `buildRequest` strips both before it builds
 * anything, so neither is ever a parameter of the target's endpoint and no recipe has to declare
 * them. `confirm` is checked by `checkPolicy`; `raw` is read by `runToolCall`.
 */
const RUNTIME_ARGS = new Set(['confirm', 'raw'])

/**
 * T-015.13 — every argument is checked against the recipe's own `request.input_schema` before a
 * request is built from it.
 *
 * The CLI used to do this by converting the schema to Zod at load time; the converter went with
 * the CLI and nothing replaced it, which left `buildRequest` putting whatever a host sent into the
 * query string or the JSON body. That does not break the trust table, but it widens every recorded
 * read into an arbitrary parameterised call: a parameter the app never sent (`role=admin`), a
 * `limit` of a million, a GraphQL `variables` object of the caller's choosing.
 *
 * Strict on purpose: an undeclared parameter is REFUSED rather than dropped, because a caller that
 * believes it filtered the results and silently did not is worse off than one that was told no.
 * The subset understood here is the subset inference emits (`type`, `properties`, `required`,
 * `items`, and a closed `enum`); a schema that constrains nothing constrains nothing.
 */
export function validateArgs(entry: SurfaceTool, args: Record<string, unknown>): void {
  const schema = entry.tool.request.input_schema as Record<string, unknown>
  const faults = check(args, schema, '', pageFilledParams(entry))
  if (faults.length === 0) return
  throw new Refusal(
    'invalid_arguments',
    `"${entry.qualified_name}" was not called the way ${siteOf(entry.base_url)} was recorded using it: ` +
      `${faults.join('; ')}. Douze did not run it.`,
  )
}

/**
 * Parameters the extension fills from page state, never the caller — `buildRequest` leaves their
 * placeholders in the URL for the executor. A recipe declares them as required path parameters, so
 * they are exempt from the required check or every call to such a tool would be refused.
 */
const pageFilledParams = (entry: SurfaceTool): Set<string> =>
  new Set(
    entry.credential_source.flatMap((source) =>
      source.kind === 'page_state' && source.param ? [source.param] : [],
    ),
  )

function check(value: unknown, schema: Record<string, unknown>, path: string, exempt: ReadonlySet<string>): string[] {
  const type = schema['type']
  if (typeof type === 'string' && !isType(value, type)) return [`${path || 'the arguments'} must be ${type}`]
  const allowed = schema['enum']
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    return [`${path} must be one of ${allowed.map((option) => JSON.stringify(option)).join(', ')}`]
  }
  const items = schema['items']
  if (Array.isArray(value) && isRecord(items)) {
    return value.flatMap((item, index) => check(item, items, `${path}[${index}]`, EMPTY))
  }
  const properties = schema['properties']
  // No declared properties is no constraint: inference emits `{}` for a shape it could not pin
  // down, and inventing a constraint there would refuse calls the recording proves are fine.
  if (!isRecord(value) || !isRecord(properties)) return []
  const faults: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (path === '' && RUNTIME_ARGS.has(key)) continue
    const sub = properties[key]
    if (isRecord(sub)) faults.push(...check(child, sub, join(path, key), EMPTY))
    else faults.push(`"${join(path, key)}" is not a parameter of this tool`)
  }
  for (const key of (schema['required'] as string[] | undefined) ?? []) {
    if (!(key in value) && !exempt.has(key) && !RUNTIME_ARGS.has(key)) faults.push(`"${join(path, key)}" is required`)
  }
  return faults
}

const EMPTY: ReadonlySet<string> = new Set()

const join = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isType(value: unknown, type: string): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number'
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isRecord(value)
  if (type === 'null') return value === null
  return typeof value === type
}

/** AC-EXE-002.1 — 401, 403, or a login redirect all mean the same thing to the user. */
export function classify(entry: SurfaceTool, response: RelayResponse): void {
  if (!(response.status === 401 || response.status === 403 || response.redirected_to_login)) return
  throw new DouzeError(
    'session_expired',
    `You have been signed out of ${siteOf(entry.base_url)}. Sign in again in Chrome, then retry.`,
    { tool: entry.qualified_name, target: entry.base_url },
  )
}

// --- the rate limiter ------------------------------------------------------

/**
 * AC-EXE-003.1 — excess calls queue rather than drop, per tool, so a throttled tool never blocks
 * another. Bounded by `RATE_WAIT_MAX_MS`: see the comment there for why a worker may not wait a
 * minute. Every chain lives in the worker and dies with it, which is correct — the host fails
 * whatever was in flight when the socket went, and never re-sends it.
 */
export class RateLimiter {
  private readonly calls = new Map<string, number[]>()
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly maxWaitMs = RATE_WAIT_MAX_MS) {}

  run<T>(key: string, limit: number | undefined, work: () => Promise<T>): Promise<T> {
    if (!limit) return work()
    const chained = (this.queues.get(key) ?? Promise.resolve()).then(async () => {
      await this.admit(key, limit)
      this.calls.set(key, [...this.recent(key), Date.now()])
      return work()
    })
    this.queues.set(
      key,
      chained.catch(() => undefined),
    )
    return chained
  }

  private async admit(key: string, limit: number): Promise<void> {
    const recent = this.recent(key)
    if (recent.length < limit) return
    const wait = 60_000 - (Date.now() - (recent[0] as number))
    if (wait > this.maxWaitMs) {
      throw new DouzeError(
        'rate_limited',
        `"${key}" is limited to ${limit} calls a minute and has used them. Try again in ` +
          `${Math.ceil(wait / 1000)} seconds.`,
        { tool: key, retry_after_ms: wait },
      )
    }
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }

  private recent(key: string): number[] {
    const now = Date.now()
    return (this.calls.get(key) ?? []).filter((at) => now - at < 60_000)
  }
}

// --- result shaping --------------------------------------------------------

export interface Shaped {
  data: unknown
  /** AC-RUN-004.2 — present only when the result was cut; the caller must be told. */
  truncated?: { message: string; untrimmed_bytes: number; returned_bytes: number }
  /** Set when the recipe's payload path did not resolve, so the full body was returned instead. */
  note?: string
}

/** The payload the recipe's path selected, still structured and not yet capped. */
export interface Selected {
  data: unknown
  note?: string
}

/**
 * REQ-RUN-004 — trimmed to the recipe's Primary Payload Path, and nothing else.
 *
 * Split from the cap because the secret gate has to run BETWEEN the two: it walks a JSON document,
 * and a truncated one is a string that no longer parses.
 */
export function selectPayload(
  body: unknown,
  options: { primary_payload_path?: string | undefined; raw?: boolean | undefined } = {},
): Selected {
  const path = options.primary_payload_path
  if (options.raw || !path) return { data: body }
  const picked = selectPath(body, path)
  // Returning the envelope beats returning nothing: a stale path must not eat the response.
  if (picked === MISSING) {
    return { data: body, note: `primary_payload_path "${path}" did not resolve; returning the full body.` }
  }
  return { data: picked }
}

/**
 * AC-RUN-004.2 — capped, so a chat context is not spent on one response. Ported from the CLI's
 * shape.ts with `Buffer` replaced by `TextEncoder`: there is no Buffer in a service worker.
 */
export function capResult(selected: Selected): Shaped {
  const { data, note } = selected
  const text = json(data)
  const encoded = byteLength(text)
  if (encoded <= MAX_RESULT_BYTES) return note === undefined ? { data } : { data, note }

  const returned = cutToBytes(text, MAX_RESULT_BYTES)
  return {
    data: returned,
    truncated: {
      message: `Result truncated to ${MAX_RESULT_BYTES} bytes; the untrimmed result was ${encoded} bytes.`,
      untrimmed_bytes: encoded,
      returned_bytes: byteLength(returned),
    },
    ...(note === undefined ? {} : { note }),
  }
}

/** Both halves, for a caller that has nothing to do between them. */
export const shapeResult = (
  body: unknown,
  options: { primary_payload_path?: string | undefined; raw?: boolean | undefined } = {},
): Shaped => capResult(selectPayload(body, options))

/** Distinguishes "the path selected `undefined`" from "the path does not exist". */
export const MISSING = Symbol('missing')

/**
 * The subset of JSONPath recipes actually record: a rooted dot/bracket path such as
 * `$.data.orders[0].id`. Filters and wildcards are unsupported — inference never emits them.
 */
export function selectPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of segments(path)) {
    if (current === null || current === undefined) return MISSING
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return MISSING
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return MISSING
    const record = current as Record<string, unknown>
    if (!(segment in record)) return MISSING
    current = record[segment]
  }
  return current
}

/**
 * Cuts a string to at most `limit` BYTES without splitting a UTF-8 sequence.
 *
 * Cutting the encoded bytes and decoding looks right and is not: a split multi-byte sequence
 * decodes to a 3-byte U+FFFD, so an emoji straddling the boundary comes back one or two bytes OVER
 * the cap this exists to enforce. A continuation byte is 0b10xxxxxx, so walking back to the last
 * lead byte finds the real boundary.
 */
export function cutToBytes(value: string, limit: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= limit) return value
  let end = limit
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1
  return new TextDecoder().decode(bytes.subarray(0, end))
}

// --- the result secret gate ------------------------------------------------

/**
 * T-014.4, ported — the last gate before a result leaves the browser. Redaction runs on the way
 * into a fixture, but a live dashboard response is not a fixture: it is whatever the target
 * returned just now, and whoever is attached stores it. A credential-shaped value in it is refused
 * by default, naming where it was, and released only by exempting the tool.
 *
 * **Where the exemption lives now that relay.json is gone:** `chrome.storage.local` under
 * `attach:expose`, as `{ local: string[], remote: string[] }` — qualified tool names, per trust
 * level. One key, because the exemption is a property of the tool ("this tool's results
 * legitimately look like credentials") and both pipes need it; split by trust, because exempting a
 * tool so the MCP client on your own machine can read a token must not also start sending that
 * token to a relay operator.
 *
 * Give it the payload as data, never a serialised or truncated copy of it: the detector reads a
 * JSON *document*, and a string it cannot parse is judged by entropy alone.
 */
export function gateResult(tool: string, result: unknown, exposed: readonly string[]): void {
  if (exposed.includes(tool)) return
  const findings = findSurvivingSecrets(result)
  if (findings.length === 0) return
  throw new Refusal(
    'result_withheld',
    `Douze withheld this result: ${tool} returned credential-shaped values at ${findings.join(', ')}. ` +
      `Allow this tool's results in the Douze extension if you meant to send them.`,
  )
}

// --- the audit log ---------------------------------------------------------

/**
 * AC-EXE-003.3 — every invocation leaves a local trace. `douze status` printed the last few and
 * that surface must not vanish with the CLI, so it is read back over a message instead.
 *
 * Arguments are NOT recorded. douzed wrote them redacted to a 0600 file on the user's disk;
 * `chrome.storage.local` is read by every extension context and survives in a profile that syncs,
 * and the question the log answers — what ran, when, at which trust level, and how it ended — does
 * not need them. Dropping them removes the whole class of leak the daemon needed a shape gate for.
 */
export class AuditLog {
  static readonly KEY = 'attach:audit'
  /** Read-modify-write, so two calls finishing together cannot lose an entry. */
  private writes: Promise<unknown> = Promise.resolve()

  record(entry: AuditEntry): Promise<void> {
    const next = this.writes.then(async () => {
      const stored = await chrome.storage.local.get(AuditLog.KEY)
      const existing = (stored[AuditLog.KEY] as AuditEntry[] | undefined) ?? []
      await chrome.storage.local.set({ [AuditLog.KEY]: [...existing, entry].slice(-AUDIT_LIMIT) })
    })
    this.writes = next.catch(() => undefined)
    return next
  }

  /** Most recent first, which is the order anyone reading a log wants. */
  static async recent(limit = 20): Promise<AuditEntry[]> {
    const stored = await chrome.storage.local.get(AuditLog.KEY)
    const entries = (stored[AuditLog.KEY] as AuditEntry[] | undefined) ?? []
    return entries.slice(-limit).reverse()
  }
}

// --- building the request --------------------------------------------------

/**
 * Turns validated tool arguments into a concrete request: path params are substituted into the
 * Endpoint Template, the rest become a query string or a JSON body depending on the method.
 * Ported unchanged from douzed's relay.ts apart from `crypto.randomUUID`, which the worker has.
 */
export function buildRequest(
  entry: SurfaceTool,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): RelayRequest {
  const { method, path, headers, graphql } = entry.tool.request
  const remaining = { ...args }
  delete remaining['confirm']
  delete remaining['raw']

  // Parameters the PAGE fills, not the caller: the extension substitutes them after reading the
  // value out of page state. Left in the URL untouched here — resolving them to nothing produced
  // `/v1/project/apikey//origins`, which is a 404 wearing a different hat.
  const pageFilled = pageFilledParams(entry)

  const resolvedPath = path.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (pageFilled.has(name)) return whole
    const value = remaining[name]
    delete remaining[name]
    return encodeURIComponent(String(value ?? ''))
  })

  const url = new URL(resolvedPath, entry.base_url)
  let body: unknown
  if (graphql) {
    // AC-INF-004.2 — the stored document is replayed with the caller's variables.
    body = { operationName: graphql.operation, query: graphql.document, variables: remaining }
  } else if (method === 'GET' || method === 'HEAD') {
    for (const [key, value] of Object.entries(remaining)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
  } else {
    body = remaining
  }

  return {
    id: crypto.randomUUID(),
    origin: new URL(entry.base_url).origin,
    url: url.toString(),
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body }),
    credential_source: entry.credential_source,
    ...(entry.page_origin === undefined ? {} : { execute_origin: entry.page_origin }),
    timeout_ms: timeoutMs,
  }
}

// --- the one entry point ---------------------------------------------------

export interface CallDeps {
  /** The Tool Surface right now — read per call, so an approval mid-flight is picked up. */
  surface: () => readonly SurfaceTool[]
  /** `executeRelay`, bound to the worker's notify and recording-tab state. */
  execute: (request: RelayRequest) => Promise<RelayResponse>
  limiter: RateLimiter
  audit: (entry: AuditEntry) => void
  /** Whether this attachment opted into write tools. Meaningless for `local`, which has them all. */
  allowWrites: boolean
  /** Qualified tool names whose results are exempt from the secret gate at this trust level. */
  exposed: readonly string[]
  timeoutMs?: number
}

export interface CallOutcome {
  result?: unknown
  error?: ToolFailure
}

/**
 * One inbound `tool.call`, from either pipe, guarded and executed. Never throws: the caller owes
 * the host a `tool.result` for every id it was sent, and a thrown error would strand the call
 * until the host's own timeout.
 */
export async function runToolCall(
  call: { name: string; args: Record<string, unknown>; trust: Trust },
  deps: CallDeps,
): Promise<CallOutcome> {
  const started = Date.now()
  const done = (outcome: string, duration: number, status?: number): void =>
    deps.audit({
      at: new Date().toISOString(),
      tool: call.name,
      trust: call.trust,
      outcome,
      duration_ms: duration,
      ...(status === undefined ? {} : { status }),
    })

  try {
    const entry = deps.surface().find((candidate) => candidate.qualified_name === call.name)
    // `unknown_tool` and `trust_refused` read differently on purpose, and that does let a host
    // probe names it was never pushed — a guessed `shop_delete_order` comes back "never for a
    // hosted assistant" while `shop_nope` comes back "no such tool". Kept: the qualified name is
    // `recipe_tool`, and every recipe with one read tool is already on the surface that host was
    // handed, so what leaks is which sibling names exist inside recipes it can already list.
    // Collapsing the two would cost the user the only two messages that say what to do next —
    // "allow changes for this assistant" and "run it from an app on this computer" — which is a
    // bad trade for a party that must guess `recipe_tool` exactly to learn a name.
    if (!entry) throw new Refusal('unknown_tool', `Douze has no tool called "${call.name}".`)
    // Both halves of the trust table, deliberately: the surface was already filtered at push time,
    // and this runs anyway, because a host that lies about what it sent must not get through.
    checkPolicy(entry, call.args, call.trust, deps.allowWrites)

    const response = await deps.limiter.run(call.name, entry.tool.rate_limit_per_minute, () =>
      withTimeout(
        deps.execute(buildRequest(entry, call.args, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
        deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        call.name,
      ),
    )
    classify(entry, response)
    if (!response.ok && response.error !== undefined) throw executionFailure(call.name, response.error)

    const selected = selectPayload(response.body, {
      primary_payload_path: entry.tool.response.primary_payload_path,
      raw: call.args['raw'] === true,
    })
    // Gated on the STRUCTURED payload, before the cap and before the envelope. Gating the finished
    // envelope withheld every large result: the cap hands back JSON cut mid-structure, which no
    // longer parses, so the detector fell through to its entropy rule — and 32 KB of space-free
    // JSON scores far above the threshold. Truncation existed to make a big result usable; gating
    // after it made a big result impossible.
    gateResult(call.name, selected.data, deps.exposed)
    const shaped = capResult(selected)
    const result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ status: response.status ?? 0, duration_ms: response.duration_ms, ...shaped }),
        },
      ],
    }
    done('ok', Date.now() - started, response.status ?? 0)
    return { result }
  } catch (error) {
    const failure = toFailure(error)
    done(failure.code, Date.now() - started)
    return { error: failure }
  }
}

/**
 * The two `executeRelay` failures that will still be true on the next attempt, matched on the
 * sentences relay.ts writes (`relay.test.ts` pins both against these patterns, so a reworded
 * refusal fails there rather than silently becoming retryable here).
 *
 * A missing host permission needs a click in Chrome and an agent cannot produce one; an executor
 * tab that could not be opened on the target origin is the same kind of fact. Reporting either as
 * `extension_disconnected`/`retryable: true` — which is what every `response.error` used to become
 * — tells the agent to try again, and it will, for as long as it is allowed to.
 */
export const PERMISSION_MISSING = /has no permission for/
export const EXECUTOR_MISSING = /executor tab/

const executionFailure = (tool: string, error: string): Error => {
  // The relay's own sentence already names the fix — allow the permission, or open the site —
  // so it is carried through verbatim rather than replaced with a shorter one that does not.
  if (PERMISSION_MISSING.test(error)) return new Refusal('permission_required', `"${tool}" did not run. ${error}`)
  if (EXECUTOR_MISSING.test(error)) {
    return new Refusal(
      'executor_unavailable',
      `"${tool}" did not run: ${error}. Open that site in a Chrome tab, then ask again.`,
    )
  }
  // Everything else — the page's own fetch failing, an injection Chrome refused — may well work on
  // the next attempt, and keeps the code and the retry it always had.
  return new DouzeError('extension_disconnected', `"${tool}" could not run: ${error}`, { tool })
}

/** Codes a caller can usefully retry; everything else is a decision that will not change. */
const RETRYABLE = new Set(['timeout', 'rate_limited', 'extension_disconnected', 'relay_unreachable'])

const toFailure = (error: unknown): ToolFailure => {
  if (error instanceof DouzeError) {
    return { code: error.code, message: error.message, retryable: RETRYABLE.has(error.code) }
  }
  // A refusal by policy is never retryable: nothing the caller can change about the call helps.
  if (error instanceof Refusal) return { code: error.code, message: error.message, retryable: false }
  return {
    code: 'internal_error',
    message: `Douze could not run this tool: ${String((error as Error)?.message ?? error)}`,
    retryable: false,
  }
}

const withTimeout = <T>(work: Promise<T>, ms: number, tool: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DouzeError('timeout', `Tool "${tool}" did not return within ${humanDuration(ms)}.`, { tool })),
        ms,
      )
    }),
  ])
}

/**
 * The site as the reader knows it. A scheme is our plumbing, not part of the name anyone would say
 * out loud; the port stays, because for a local app it is genuinely part of the address.
 */
const siteOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** "120000ms" is a number the reader has to convert; this is the same fact in their units. */
const humanDuration = (ms: number): string => {
  if (ms < 60_000) {
    const seconds = Math.round(ms / 1000)
    return seconds === 1 ? '1 second' : `${seconds} seconds`
  }
  const minutes = Math.round(ms / 60_000)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

const json = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null'))

const byteLength = (value: string): number => new TextEncoder().encode(value).length

const segments = (path: string): string[] =>
  path
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\['([^']*)'\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0)

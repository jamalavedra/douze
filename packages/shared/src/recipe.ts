import { z } from 'zod'

/** Current recipe schema version. Bump on any breaking field change; add a migration in migrate.ts. */
export const RECIPE_VERSION = 1

/** AC-INF-003.1/.2 — read is safe to replay, destructive needs `confirm`. */
export const SideEffect = z.enum(['read', 'write', 'destructive'])

/** AC-DRF-001.2 — the five outcomes a Doctor Run can report per tool. */
export const DriftStatus = z.enum(['ok', 'schema_widened', 'breaking', 'session_expired', 'gone'])

/**
 * AC-REC-001.2 — a recipe records only where a credential comes from, never a value.
 * `cookie` needs nothing: the browser attaches it. `page_state` names the expression the
 * app itself uses, which the extension re-reads at call time (AC-EXE-001.3).
 */
export const CredentialSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cookie') }),
  z.object({
    kind: z.literal('page_state'),
    /** Expression evaluated in the page's MAIN world, e.g. `localStorage.getItem('token')`. */
    expression: z.string(),
    /** Header the value is attached to, e.g. `authorization`. */
    header: z.string(),
    /** Optional literal prefix, e.g. `Bearer `. */
    prefix: z.string().default(''),
  }),
])

export const AuthDescriptor = z.object({
  mode: z.enum(['browser_relay', 'headless']).default('browser_relay'),
  credential_source: z.array(CredentialSource).default([{ kind: 'cookie' }]),
  /** AC-EXE-004.2 — headless refresh endpoint, applied once on 401. */
  refresh_endpoint: z.string().optional(),
  /** AC-EXE-004.1 — keychain reference only, never a session value. */
  keychain_ref: z.string().optional(),
})

/** REQ-INF-005 — how a paginated collection is driven. */
export const Pagination = z.object({
  style: z.enum(['page', 'cursor', 'offset']),
  /** Request param carrying the page/cursor/offset. */
  param: z.string(),
  /** JSONPath to the next cursor in the response, for cursor style. */
  next_path: z.string().optional(),
})

export const RequestContract = z.object({
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** Endpoint Template with `{param}` segments — REQ-INF-001. */
  path: z.string(),
  /** AC-INF-002.4 — JSON Schema, converted to Zod at load time. */
  input_schema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  /** Static headers observed as required by the app (never credentials). */
  headers: z.record(z.string(), z.string()).default({}),
  /** AC-INF-004.2 — the GraphQL document, stored with the recipe. */
  graphql: z.object({ operation: z.string(), document: z.string() }).optional(),
})

export const ResponseContract = z.object({
  /** AC-INF-005.1 — JSONPath to the useful subtree, minus the envelope. */
  primary_payload_path: z.string().optional(),
  output_schema: z.record(z.string(), z.unknown()).default({}),
  pagination: Pagination.optional(),
})

/** Flags are advisory metadata the runtime and review UI act on. */
export const ToolFlags = z.object({
  /** AC-INF-002.3 — inferred from a single observation. */
  sparse: z.boolean().default(false),
  /** AC-INF-004.3 — GraphQL operation was anonymous; name came from the root field. */
  derived_name: z.boolean().default(false),
  /** AC-REC-003.2 — retained across a recapture that no longer observed it. */
  unverified: z.boolean().default(false),
  last_observed: z.string().optional(),
  /** AC-DRF-002.1 — set by a Doctor Run; the runtime rejects calls to this tool. */
  degraded: z.boolean().default(false),
  degraded_reason: z.string().optional(),
  /** AC-REC-002.2 — fields the user hand-edited, protected from re-inference. */
  user_edited: z.array(z.string()).default([]),
  /** AC-REC-003.1 — inferred values that lost to a user edit, kept as suggestions. */
  suggestions: z.record(z.string(), z.unknown()).default({}),
})

export const Tool = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'tool names are snake_case'),
  description: z.string(),
  side_effect: SideEffect,
  /** REQ-INF-002 — 0..1 from observation count, schema stability, side-effect certainty. */
  confidence: z.number().min(0).max(1),
  observations: z.number().int().nonnegative(),
  /** AC-REC-002.5 — the runtime exposes approved tools only. */
  approved: z.boolean().default(false),
  request: RequestContract,
  response: ResponseContract.prefault({}),
  /** AC-REC-004.1 — approved tools reference at least one fixture (enforced below). */
  fixtures: z.array(z.string()).default([]),
  /** AC-EXE-003.1 — per-tool rate limit; recond queues rather than drops. */
  rate_limit_per_minute: z.number().int().positive().optional(),
  /** REQ-CAP-007 — the note that produced this tool, kept as description evidence. */
  annotation: z.string().optional(),
  flags: ToolFlags.prefault({}),
})

export const Recipe = z
  .object({
    version: z.number().int().positive(),
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'recipe names are kebab-case'),
    enabled: z.boolean().default(true),
    target: z.object({ base_url: z.url() }),
    auth: AuthDescriptor.prefault({}),
    tools: z.array(Tool).default([]),
  })
  .superRefine((recipe, ctx) => {
    const seen = new Set<string>()
    for (const [i, tool] of recipe.tools.entries()) {
      if (seen.has(tool.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', i, 'name'],
          message: `duplicate tool name "${tool.name}" in recipe "${recipe.name}"`,
        })
      }
      seen.add(tool.name)
      if (tool.approved && tool.fixtures.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', i, 'fixtures'],
          message: `approved tool "${tool.name}" must reference at least one fixture`,
        })
      }
      // AC-REC-002.4 — a destructive tool is only callable with an explicit confirm.
      if (tool.approved && tool.side_effect === 'destructive' && !hasConfirm(tool)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', i, 'request', 'input_schema'],
          message: `approved destructive tool "${tool.name}" must require a "confirm" parameter`,
        })
      }
    }
  })

function hasConfirm(tool: z.infer<typeof Tool>): boolean {
  const schema = tool.request.input_schema as { required?: unknown }
  return Array.isArray(schema.required) && schema.required.includes('confirm')
}

export type Recipe = z.infer<typeof Recipe>
export type Tool = z.infer<typeof Tool>
export type SideEffect = z.infer<typeof SideEffect>
export type DriftStatus = z.infer<typeof DriftStatus>
export type CredentialSource = z.infer<typeof CredentialSource>
export type RequestContract = z.infer<typeof RequestContract>
export type ResponseContract = z.infer<typeof ResponseContract>

/** The `confirm` parameter injected into every approved destructive tool (AC-REC-002.4). */
export const CONFIRM_PARAM = {
  type: 'boolean',
  description: 'Must be true. This tool performs a destructive action that cannot be undone.',
} as const

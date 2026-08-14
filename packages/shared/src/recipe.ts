import { z } from 'zod'

/** Current recipe schema version. Bump on any breaking field change; add a migration in migrate.ts. */
export const RECIPE_VERSION = 1

/** AC-INF-003.1/.2 — read is safe to replay, destructive needs `confirm`. */
export const SideEffect = z.enum(['read', 'write', 'destructive'])

/**
 * The cap on a tool's model-facing text, matching `AttachedTool.description` in
 * packages/mcp-host/src/protocol.ts.
 *
 * It has to be enforced HERE and not only there, because a host drops a frame it cannot parse and
 * `surface.push` carries the whole surface in one frame: one recipe with a 5 KB description made
 * every tool of every recipe vanish from every hosted client, with no error at either end. The
 * recipe schema is the boundary the bad value has to fail at, since that is the only one an
 * imported file passes through before it is stored.
 *
 * `describe()` (packages/extension/src/guards.ts) composes the pushed text out of the description
 * plus the destructive and degraded sentences, so it cuts to this same number on the way out — a
 * tool with a shortened description is a far smaller loss than a surface with no tools at all.
 */
export const MAX_DESCRIPTION = 4096

/**
 * Name lengths, for the same reason and with the same failure mode. `AttachedTool.name` is
 * `/^[a-zA-Z0-9_-]{1,128}$/` and the pushed name is `<recipe>_<tool>`, so two unbounded names
 * compose into a frame the host refuses — and takes the whole surface with it.
 */
export const MAX_NAME = 60

/**
 * AC-REC-001.2 — a recipe records only where a credential comes from, never a value.
 * `cookie` needs nothing: the browser attaches it. `page_state` names the expression the
 * app itself uses, which the extension re-reads at call time (AC-EXE-001.3).
 */
export const CredentialSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cookie') }),
  /**
   * A header value the site hardcodes, kept verbatim because there is nowhere to re-read it from.
   * x.com's `authorization` bearer is the case: a public application constant in its JS bundle,
   * identical for every visitor, and without it every call is refused 403.
   *
   * A skill using one stops working if the site rotates the token, and re-recording is the fix.
   *
   * Nothing that RECORDS a site puts one here: the extension keeps an approved value per origin in
   * `auth:literals` and re-reads it at call time (`approvedLiterals` in extension/src/relay.ts), so
   * an exported skills file still carries no credential. This slot exists for a recipe written or
   * imported by hand, which is the one path that can carry a value — and the write gate exempts
   * exactly this field for it (`APPROVED_LITERAL` in redact.ts).
   */
  z.object({
    kind: z.literal('literal'),
    value: z.string(),
    header: z.string(),
    prefix: z.string().default(''),
  }),
  z.object({
    kind: z.literal('page_state'),
    /** Expression evaluated in the page's MAIN world, e.g. `localStorage.getItem('token')`. */
    expression: z.string(),
    /** Header the value is attached to, e.g. `authorization`. Absent when it fills `param`. */
    header: z.string().optional(),
    /**
     * Endpoint Template parameter the value fills, e.g. `{projectKey}` in
     * `/v1/project/apikey/{projectKey}/origins`.
     *
     * A project key in the path is a credential by shape, so redaction replaces it — and a recipe
     * carrying the placeholder called a URL that does not exist, which the API answered with
     * "Invalid API key format". The caller cannot supply it either: an agent has no idea what the
     * project's key is. The page does, and it is read at call time exactly like a header.
     */
    param: z.string().optional(),
    /** Optional literal prefix, e.g. `Bearer `. */
    prefix: z.string().default(''),
  }),
])

export const AuthDescriptor = z.object({
  /**
   * Every call runs in the browser. `headless` was a second mode that executed from a daemon with
   * a session out of the OS keychain; it died with the daemon, and a recipe declaring it would
   * have loaded and then executed through the browser anyway. Kept as an accepted value only so an
   * older recipe still parses — nothing reads it.
   */
  mode: z.enum(['browser_relay', 'headless']).default('browser_relay'),
  credential_source: z.array(CredentialSource).default([{ kind: 'cookie' }]),
  /**
   * AC-EXE-001.3 — the origin whose tab executes the call. Absent means the target's own origin,
   * which is right for a site that serves its own API. A dashboard calling an API host needs its
   * own page: that is where the token lives and the origin the target's CORS expects.
   */
  page_origin: z
    .string()
    .refine(isHttpOrigin, 'page_origin must be an http(s) origin, with no path — e.g. https://app.example')
    .optional(),
})

/**
 * An origin and nothing else. `page_origin` becomes a `chrome.tabs.create` URL and the target of a
 * MAIN-world `executeScript`, and it is compared against `new URL(tab.url).origin`, so a value
 * carrying a path never matches any tab and a `javascript:` value has no business being opened at
 * all. It is also passed to `chrome.permissions.contains` as `${origin}/*`, which throws on a
 * malformed match pattern — outside the relay's try block, so the user got a raw internal error
 * instead of the sentence that names the fix.
 */
function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}

/** REQ-INF-005 — how a paginated collection is driven. */
export const Pagination = z.object({
  style: z.enum(['page', 'cursor', 'offset']),
  /** Request param carrying the page/cursor/offset. */
  param: z.string(),
  /** JSONPath to the next cursor in the response, for cursor style. */
  next_path: z.string().optional(),
})

/**
 * The methods a recipe can describe, and therefore the only ones an exchange can become a tool
 * from. Exported because the inference engine has to skip anything else rather than carry it into
 * a schema that will reject it — a stored `OPTIONS` preflight once made `infer` throw and blanked
 * the whole review page. One list, so the filter and the schema cannot disagree about it.
 */
export const TOOL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

export const RequestContract = z.object({
  method: z.enum(TOOL_METHODS),
  /**
   * Endpoint Template with `{param}` segments — REQ-INF-001.
   *
   * Site-relative, and only site-relative. `buildRequest` resolves this against the recipe's
   * `base_url`, and `new URL()` discards that base for anything that is not: an absolute
   * `https://evil.example/steal`, a protocol-relative `//evil.example/steal`, a leading
   * `/\evil.example` (a backslash is a slash to the URL parser), or a `/\n//evil.example` (tabs
   * and newlines are stripped before parsing). Any of those turns a recipe someone sent the user
   * into a request that runs on their real dashboard with its cookies and page-state token
   * attached, aimed at the sender's server — or at 169.254.169.254.
   *
   * Nothing legitimate is lost: inference only ever emits `new URL(exchange.url).pathname`
   * (packages/studio/src/inference/graphql.ts) or `/` joined over non-empty path segments
   * (packages/studio/src/inference/templating.ts), and a pathname percent-encodes whitespace and
   * backslashes. `executeRelay` checks the same thing again against the URL it is about to fetch,
   * because a recipe stored before this rule existed does not re-validate itself.
   */
  path: z
    .string()
    .regex(
      /^\/(?!\/)[^\s\\]*$/,
      'request paths must be site-relative: one leading "/", no scheme, host, backslash or whitespace',
    ),
  /**
   * AC-INF-002.4 — JSON Schema, kept as JSON Schema: it is pushed to a host verbatim as the
   * tool's `input_schema`, and `checkPolicy` (packages/extension/src/guards.ts) validates every
   * inbound argument against it before a request is built. The CLI converted it to Zod at load
   * time; the CLI is gone and so is the converter.
   */
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
  /**
   * AC-RUN-001.5 — the runtime rejects calls to this tool before it issues a request.
   *
   * The Doctor Run that used to set it from a live replay went with the daemon (WO-015 T-015.13),
   * and nothing replaced it: the only producer left is `RecipeStore`'s load-time check that an
   * approved tool's fixture is present (packages/extension/src/recipes.ts). The flag stays in the
   * schema because it is still written by that check, still honoured by `checkPolicy`, and still
   * survives an export/import round trip.
   */
  degraded: z.boolean().default(false),
  /** Bounded because `describe()` appends it to the pushed description — see MAX_DESCRIPTION. */
  degraded_reason: z.string().max(1024).optional(),
  /** AC-REC-002.2 — fields the user hand-edited, protected from re-inference. */
  user_edited: z.array(z.string()).default([]),
  /** AC-REC-003.1 — inferred values that lost to a user edit, kept as suggestions. */
  suggestions: z.record(z.string(), z.unknown()).default({}),
})

export const Tool = z.object({
  name: z.string().max(MAX_NAME).regex(/^[a-z][a-z0-9_]*$/, 'tool names are snake_case'),
  description: z.string().max(MAX_DESCRIPTION),
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
  /** AC-EXE-003.1 — per-tool rate limit; the extension's limiter queues rather than drops. */
  rate_limit_per_minute: z.number().int().positive().optional(),
  /** REQ-CAP-007 — the note that produced this tool, kept as description evidence. */
  annotation: z.string().optional(),
  flags: ToolFlags.prefault({}),
})

export const Recipe = z
  .object({
    version: z.number().int().positive(),
    name: z.string().max(MAX_NAME).regex(/^[a-z][a-z0-9-]*$/, 'recipe names are kebab-case'),
    enabled: z.boolean().default(true),
    /**
     * `z.url()` alone accepts `javascript:`, `data:` and `file:` — verified against zod 4.4.3.
     * Nothing downstream is known to be exploitable through one (the first two throw inside
     * `new URL(path, base_url)`, and `file:` produces the origin `null` that the host-permission
     * check refuses), but the allow-list belongs at the boundary rather than in three accidents.
     */
    target: z.object({ base_url: z.url({ protocol: /^https?$/ }) }),
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
      // An imported file asserts its own side-effect label. Method semantics are the minimum
      // classification it may claim, otherwise DELETE/PUT/PATCH/POST can bypass the write gates by
      // calling itself a read. GraphQL POST queries are the one modelled read-over-POST case.
      const method = tool.request.method
      const isGraphqlQuery = method === 'POST' && tool.request.graphql !== undefined
      if (method === 'DELETE' && tool.side_effect !== 'destructive') {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', i, 'side_effect'],
          message: `tool "${tool.name}" uses DELETE, so it must be side_effect "destructive"`,
        })
      } else if (tool.side_effect === 'read' && ['POST', 'PUT', 'PATCH'].includes(method) && !isGraphqlQuery) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', i, 'side_effect'],
          message: `tool "${tool.name}" uses ${method}, so it cannot be side_effect "read"`,
        })
      }
      /**
       * A GraphQL document is a program, and `side_effect` next to it is a label the file asserts
       * rather than anything derived from what the document does. Inference DOES derive it — a
       * mutation is classified from `op.kind` (packages/studio/src/inference/engine.ts) — so this
       * only ever fires on a recipe someone wrote or was sent: `mutation deleteEverything { … }`
       * under `side_effect: read` is offered to a hosted assistant with no write opt-in and no
       * `confirm`, which is every guard in the trust table laundered by one word of YAML.
       *
       * Refused rather than downgraded. A downgrade would quietly disagree with the description
       * the same file wrote ("looks things up"), and the honest report is that the recipe is
       * lying about itself.
       */
      if (tool.request.graphql && tool.side_effect === 'read' && graphqlHasMutation(tool.request.graphql.document)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', i, 'side_effect'],
          message:
            `tool "${tool.name}" replays a GraphQL mutation, so it cannot be side_effect "read" — ` +
            `a mutation changes data`,
        })
      }
    }
  })

/**
 * Whether a GraphQL document defines a mutation operation.
 *
 * Brace depth rather than a bare `\bmutation\b`: `mutation` is an ordinary field name and a
 * document that merely mentions one must not be refused. An operation definition can only appear
 * at depth 0, so that is the only place the token counts. String literals and `#` comments are
 * blanked first, because either can carry the word without defining anything.
 *
 * Every operation in the document is considered, not just the one `graphql.operation` names: the
 * document is replayed verbatim (`buildRequest`), and a server that ignores `operationName` on a
 * single-operation-looking document is not a thing to bet a delete on.
 */
export function graphqlHasMutation(document: string): boolean {
  const stripped = document.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"/g, '""').replace(/#[^\n]*/g, '')
  let depth = 0
  for (const [token] of stripped.matchAll(/[{}]|\bmutation\b/g)) {
    if (token === '{') depth += 1
    else if (token === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0) return true
  }
  return false
}

function hasConfirm(tool: z.infer<typeof Tool>): boolean {
  const schema = tool.request.input_schema as { required?: unknown }
  return Array.isArray(schema.required) && schema.required.includes('confirm')
}

export type Recipe = z.infer<typeof Recipe>
export type Tool = z.infer<typeof Tool>
export type SideEffect = z.infer<typeof SideEffect>
export type CredentialSource = z.infer<typeof CredentialSource>
export type RequestContract = z.infer<typeof RequestContract>
export type ResponseContract = z.infer<typeof ResponseContract>

/** The `confirm` parameter injected into every approved destructive tool (AC-REC-002.4). */
export const CONFIRM_PARAM = {
  type: 'boolean',
  description: 'Must be true. This tool performs a destructive action that cannot be undone.',
} as const

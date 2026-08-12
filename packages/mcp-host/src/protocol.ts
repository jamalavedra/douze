import { z } from 'zod'
import { HEARTBEAT_MS, SideEffect } from '@douze/shared'

/**
 * WO-015 T-015.6 — **the attachment protocol**: the frames an MCP host and a Douze extension
 * exchange over the one socket between them. Both pipes speak it — the cloud relay (WSS, one
 * socket per endpoint, many MCP sessions on it) and the local bridge (loopback WS, one session) —
 * so the extension has a single implementation and does not care which is on the far side.
 *
 * The split of responsibilities it encodes: the **host** owns MCP sessions, the cached tool
 * surface, and every id it needs to correlate a call. The **extension** owns recipes, storage,
 * guards and execution, and holds no session state at all, because an MV3 service worker Chrome
 * can evict cannot hold any. Only `tool.call` needs the browser awake.
 */

/**
 * What an attachment is, decided by whoever built the host and never claimed by a client:
 * `local` is a loopback bridge the user paired in person, `remote` is anything else.
 *
 * The extension deliberately does NOT take this off the frame. It derives its own level from what
 * it dialled, because a host that lies would otherwise talk itself into destructive tools; this
 * field tells the extension what the host believes, and the guards decide anyway. See the trust
 * table in packages/extension/src/guards.ts.
 */
export const Trust = z.enum(['local', 'remote'])
export type Trust = z.infer<typeof Trust>

/**
 * One tool as the extension advertises it — exactly what `tools/list` needs and nothing more.
 *
 * `description` is rendered verbatim: the extension composes it (the destructive sentence, the
 * degraded reason) the way `describe()` in the CLI's surface.ts does today, because a chat client
 * selects on the description alone (ADR-008). The host appends nothing.
 */
export const AttachedTool = z.object({
  /** The qualified `<recipe>_<tool>` name a client calls; MCP's own name charset. */
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/, 'tool names are <recipe>_<tool>, alphanumeric with _ or -'),
  description: z.string().max(4096),
  /** JSON Schema for the arguments, handed to the client untouched. */
  input_schema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  /** Drives the MCP annotations below; the host never guesses one from the name. */
  side_effect: SideEffect,
})
export type AttachedTool = z.infer<typeof AttachedTool>

/** Why one `tool.call` did not produce a result. `code` is a `RelayErrorCode` in practice. */
export const ToolFailure = z.object({
  /**
   * Free-form rather than the `RelayErrorCode` enum on purpose: a frame that fails to parse is
   * dropped, and dropping a `tool.result` hangs the call until its timeout. A guard the extension
   * grows tomorrow must be able to name itself without stranding calls on an older host.
   */
  code: z.string().max(64),
  message: z.string().max(4096),
  /** False means calling again cannot help — a degraded tool, a refusal by trust level. */
  retryable: z.boolean().default(false),
})
export type ToolFailure = z.infer<typeof ToolFailure>

/** extension → host. */
export const ExtensionFrame = z.discriminatedUnion('type', [
  /** First frame after connect. */
  z.object({ type: z.literal('hello'), extension_version: z.string().max(32) }),
  z.object({ type: z.literal('pong') }),
  /** Sent on connect and on every recipe change; replaces the cached surface wholesale. */
  z.object({ type: z.literal('surface.push'), tools: z.array(AttachedTool).max(512) }),
  /**
   * The answer to one `tool.call`, carrying that call's id. Exactly one of `result` / `error`:
   * `result` is an MCP `CallToolResult` the extension already shaped and gated, passed through
   * to the client untouched.
   */
  z.object({
    type: z.literal('tool.result'),
    id: z.string(),
    result: z.unknown().optional(),
    error: ToolFailure.optional(),
  }),
])
export type ExtensionFrame = z.infer<typeof ExtensionFrame>

/** host → extension. */
export const HostFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), heartbeat_ms: z.number().int().positive() }),
  z.object({ type: z.literal('ping') }),
  /**
   * Run this tool. `id` is minted by the host and is unique across every session on the
   * attachment, so a transport can route the `tool.result` back by remembering the id it sent.
   * `args` is the client's own input, untouched; `trust` is stamped by the host from how it was
   * constructed and is not reachable from anything a client sends.
   */
  z.object({
    type: z.literal('tool.call'),
    id: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    trust: Trust,
  }),
])
export type HostFrame = z.infer<typeof HostFrame>

/** The handshake reply a transport owes an extension that said `hello`. */
export const welcome = (heartbeatMs: number = HEARTBEAT_MS): HostFrame => ({
  type: 'welcome',
  heartbeat_ms: heartbeatMs,
})

/**
 * The MCP annotations for a side effect — the same mapping `define()` in the CLI's surface.ts
 * uses, kept in one place so a client never sees two conventions.
 */
export const annotationsFor = (
  sideEffect: SideEffect,
): { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } => ({
  readOnlyHint: sideEffect === 'read',
  destructiveHint: sideEffect === 'destructive',
  idempotentHint: sideEffect === 'read',
  openWorldHint: true,
})

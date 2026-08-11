import { HostFrame, type AttachedTool, type ExtensionFrame, type Trust } from '@douze/mcp-host'
import {
  BRIDGE_PORT_RANGE,
  codeKey,
  isNonce,
  mintNonce,
  proof,
  proofMatches,
  secretHashKey,
  sha256Hex,
  type RelayRequest,
  type RelayResponse,
} from '@douze/shared'
import { AuditLog, RateLimiter, attachedSurface, runToolCall, type AuditEntry } from './guards.js'
import type { SurfaceTool } from './recipes.js'

/**
 * WO-015 T-015.8 — **the attachment client**: one outbound WebSocket implementation used for both
 * hosts, because the whole architecture rests on the extension not caring which is on the far side.
 * The cloud relay (`wss://…/ws`, WO-014) and the local stdio bridge (`ws://127.0.0.1:891x/ws`,
 * T-015.11) speak the same attachment protocol from `@douze/mcp-host`, so there is one of these.
 *
 * The extension always dials; it can never listen, and neither host can wake it. `chrome.alarms`
 * is the resurrection mechanism — its 30-second floor is why the hosts hold a call for 40 seconds
 * before reporting the browser as gone — and the alarm is recreated at every worker start, because
 * an evicted worker loses every timer it had.
 *
 * **Trust is derived here, from what was dialled AND from what the far side proved.** A `tool.call`
 * carries the host's own `trust` claim; it is deliberately ignored, because a relay operator or
 * anyone holding a stolen URL can put whatever they like in it. `local` is a bridge that answered
 * the handshake in `@douze/shared`'s bridge-handshake.ts with a proof only the holder of this
 * install's credential could compute; everything else is `remote`. Dialling loopback is not that
 * proof: binding 127.0.0.1 needs no privilege, so any process on this machine can be first to
 * 8913 and wait for the next alarm. The guards in guards.ts read only the value below.
 */

const RECONNECT_ALARM = 'douze-attach'
/** `chrome.alarms` will not fire faster than this, which sets the floor for every backoff below. */
const ALARM_PERIOD_MINUTES = 0.5
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 240_000
/** No frame at all for this many heartbeats and the socket is half-open rather than idle. */
const SILENCE_FACTOR = 2.5
const DEFAULT_HEARTBEAT_MS = 20_000

export const RELAY_KEY = 'attach:relay'
export const BRIDGE_KEY = 'attach:bridge'
export const EXPOSE_KEY = 'attach:expose'

/** What `douze connect` used to put in `~/.douze/relay.json`, in extension storage instead. */
export interface RelayPairing {
  /** Relay base URL, no trailing slash — `https://relay.example`. */
  url: string
  /** Authenticates this extension's socket; travels beside `hello`, not inside the protocol. */
  token: string
  /** Path half of the platform-facing MCP URL. The connect page shows it; nothing here uses it. */
  mcp_path: string
  /** T-015.9 — write tools stay off the remote surface unless this is set. */
  allow_writes: boolean
}

/**
 * The bridge half. `secret` is the 32-byte credential the bridge minted on the first pairing and
 * handed back on the raw `welcome` — after the handshake, never before it; `code` is what the user
 * typed in from the bridge's stderr and is spent the moment a pairing succeeds. Neither is ever
 * put on the wire: both are only ever HMAC keys. `blocked` means a host answered 1008 — see
 * `onClose`.
 */
export interface BridgePairing {
  secret?: string
  code?: string
  blocked?: boolean
}

/** Per-trust exemptions from the result secret gate. See `gateResult` for why it is split. */
export interface ExposeLists {
  local: string[]
  remote: string[]
}

export interface AttachDeps {
  /** The Tool Surface right now. */
  surface: () => readonly SurfaceTool[]
  /** `executeRelay`, bound to the worker's notify and recording-tab state. */
  execute: (request: RelayRequest) => Promise<RelayResponse>
  /** AC-EXE-002.3 / 1008 — how the worker tells the user something needs them. */
  notify: (id: string, title: string, message: string) => void
}

type Target =
  | { kind: 'relay'; key: string; url: string; token: string; allowWrites: boolean }
  | { kind: 'bridge'; key: string; url: string; port: number }

/**
 * One socket to one host. Everything about the far side that policy depends on — the trust level
 * and the write opt-in — is fixed at construction from what was dialled.
 */
class Attachment {
  private socket: WebSocket | null = null
  private attached = false
  private failures = 0
  private nextAttemptAt = 0
  private silence: ReturnType<typeof setTimeout> | undefined
  private heartbeatMs = DEFAULT_HEARTBEAT_MS
  /** This dial's nonce, minted at `open` and single-use: a replayed challenge answers the old one. */
  private nonce = ''
  /** One challenge is answered per socket; a second is a peer trying to spend our CPU. */
  private challenged = false
  /** The far side proved it holds this install's bridge credential. Nothing is disclosed until it has. */
  private verified = false

  constructor(
    readonly target: Target,
    private readonly deps: AttachDeps,
    private readonly manager: Manager,
  ) {}

  get connected(): boolean {
    return this.attached && this.socket?.readyState === 1
  }

  /**
   * The trust this attachment stamps on every call it runs. A bridge is `local` only once **this
   * socket's peer** has proved it holds the credential the user typed a code to earn. Holding a
   * secret is not the test — the peer proving it holds the same one is: loopback alone is not
   * consent, because any process on the machine can listen on 127.0.0.1 and answer.
   */
  get trust(): Trust {
    return this.target.kind === 'bridge' && this.verified ? 'local' : 'remote'
  }

  private get allowWrites(): boolean {
    return this.trust === 'local' || (this.target.kind === 'relay' && this.target.allowWrites)
  }

  /** Idempotent: an alarm firing on a healthy connection is a cheap no-op. */
  connect(): void {
    const state = this.socket?.readyState
    if (state === 0 || state === 1) return
    if (Date.now() < this.nextAttemptAt) return

    let socket: WebSocket
    try {
      socket = new WebSocket(this.target.url)
    } catch {
      this.backOff()
      return
    }
    this.socket = socket
    this.nonce = mintNonce()
    this.challenged = false
    this.verified = false
    socket.addEventListener('open', () => {
      this.send(socket, this.hello())
      // Armed at `open`, not at the first frame: a host that accepts the socket and then never
      // says `welcome` would otherwise leave it in OPEN forever, and `connect()` treats OPEN as
      // healthy — so the alarm would find nothing to do for as long as the worker lived.
      this.watchSilence()
    })
    socket.addEventListener('message', (event: MessageEvent) => this.onFrame(socket, String(event.data)))
    socket.addEventListener('close', (event: CloseEvent) => this.onClose(socket, event.code))
    // A failed connect emits `error` then `close`; the backoff is applied there.
    socket.addEventListener('error', () => undefined)
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    this.attached = false
    this.verified = false
    clearTimeout(this.silence)
    socket?.close()
  }

  /** Sent on connect and on every recipe change; the host replaces its cache wholesale. */
  pushSurface(): void {
    if (!this.connected || !this.socket) return
    this.send(this.socket, { type: 'surface.push', tools: this.tools() })
  }

  private tools(): AttachedTool[] {
    return attachedSurface(this.deps.surface(), this.trust, this.allowWrites)
  }

  private hello(): ExtensionFrame & Record<string, unknown> {
    const base = { type: 'hello' as const, extension_version: version() }
    if (this.target.kind === 'relay') return { ...base, token: this.target.token }
    // A bridge hello carries no credential at all, only this dial's nonce: whatever answered on
    // this port has not proved anything yet, and the first frame is the one a rogue is waiting for.
    return { ...base, nonce: this.nonce }
  }

  private onFrame(socket: WebSocket, raw: string): void {
    if (this.socket !== socket) return
    const payload = parse(raw)
    // Until the bridge has proved itself the ONLY frame that means anything is its challenge — no
    // pong, no surface, no call, and no silence timer reset, so a peer that stalls here is closed
    // by the watchdog armed at `open` rather than kept alive by its own chatter.
    if (this.target.kind === 'bridge' && !this.verified) return void this.onChallenge(socket, payload)
    const frame = HostFrame.safeParse(payload)
    if (!frame.success) return
    this.watchSilence()
    if (frame.data.type === 'welcome') return this.onWelcome(socket, frame.data.heartbeat_ms, payload)
    if (frame.data.type === 'ping') return this.send(socket, { type: 'pong' })
    // `frame.data.trust` is the host's claim and is deliberately dropped here: `this.trust` is
    // derived from what we dialled, and the two must never meet (see the class comment).
    void this.onCall(socket, frame.data.id, frame.data.name, frame.data.args)
  }

  /**
   * The bridge's half of the handshake. It carries a proof over both nonces and this port, and it
   * is the whole basis for `local` trust: if it does not verify, this attachment sends nothing
   * back, stays `remote`, never attaches and never pins anything. Silence rather than a close, so
   * a REAL bridge that was given the wrong code still gets to answer 1008 and tell the user so.
   *
   * A rogue that squats the port instead learns nothing from the silence and is dropped by the
   * watchdog. The mismatch is deliberately not notified: a squatter must not be able to turn the
   * extension's bridge pairing off by answering badly.
   */
  private async onChallenge(socket: WebSocket, payload: unknown): Promise<void> {
    if (this.challenged || this.target.kind !== 'bridge') return
    if (!isRecord(payload) || payload['type'] !== 'bridge.challenge') return
    const bridgeNonce = payload['nonce']
    if (!isNonce(bridgeNonce)) return
    this.challenged = true
    const key = await this.handshakeKey()
    if (!key) return
    const transcript = { port: this.target.port, extensionNonce: this.nonce, bridgeNonce }
    const expected = await proof(key, { role: 'bridge', ...transcript })
    if (!proofMatches(expected, payload['proof'])) return
    if (this.socket !== socket || socket.readyState !== 1) return
    this.verified = true
    this.watchSilence()
    this.send(socket, { type: 'bridge.proof', proof: await proof(key, { role: 'extension', ...transcript }) })
  }

  /** `sha256(secret)` once paired — what the bridge stores — or the stretched code before that. */
  private async handshakeKey(): Promise<CryptoKey | null> {
    const pairing = this.manager.bridge
    if (pairing.secret) return secretHashKey(await sha256Hex(pairing.secret))
    return pairing.code ? codeKey(pairing.code) : null
  }

  private onWelcome(socket: WebSocket, heartbeatMs: number, payload: unknown): void {
    this.heartbeatMs = heartbeatMs
    this.attached = true
    this.failures = 0
    this.nextAttemptAt = 0
    // The bridge's `secret` rides on the RAW welcome — the protocol schema strips it, because it
    // is the bridge's business and not the host's. Only reachable once `verified` (see `onFrame`),
    // so a rogue cannot make us pin its own. Pinned now; the code that earned it is spent.
    const secret = isRecord(payload) ? payload['secret'] : undefined
    if (this.target.kind === 'bridge' && typeof secret === 'string') void this.manager.pinBridge(secret)
    this.watchSilence()
    // Pushed on EVERY connect, not only when the surface moved: the host caches it, and a stale
    // cache is corrected by nothing else.
    this.send(socket, { type: 'surface.push', tools: this.tools() })
  }

  /**
   * Runs one call and answers it on the socket it arrived on.
   *
   * If that socket died while the call was in flight, the answer is dropped: the host already
   * failed the call at disconnect and never re-sends it, so replying after a reconnect would
   * settle nothing and could confuse a freshly minted id.
   */
  private async onCall(socket: WebSocket, id: string, name: string, args: Record<string, unknown>): Promise<void> {
    const trust = this.trust
    const outcome = await runToolCall(
      { name, args, trust },
      {
        surface: this.deps.surface,
        execute: this.deps.execute,
        limiter: this.manager.limiter,
        audit: (entry: AuditEntry) => void this.manager.audit.record(entry),
        allowWrites: this.allowWrites,
        exposed: this.manager.expose[trust],
      },
    )
    if (this.socket !== socket || socket.readyState !== 1) return
    this.send(socket, { type: 'tool.result', id, ...outcome })
  }

  private onClose(socket: WebSocket, code: number): void {
    if (this.socket !== socket) return
    const wasAttached = this.attached
    this.socket = null
    this.attached = false
    clearTimeout(this.silence)
    // 1008 is "not paired" from both hosts — the relay says it for a token it no longer knows, the
    // bridge for a credential it never issued. Retrying forever against either is how a user ends
    // up with an extension that looks busy and does nothing, so it stops and asks.
    if (code === 1008) return void this.manager.refused(this.target)
    // A socket that had attached and then dropped is a host that restarted or a network that
    // blinked, not an endpoint that is refusing us: the next alarm retries it at once. Backoff is
    // for a dial that never got as far as `welcome`, where retrying every 30s buys nothing.
    if (!wasAttached) this.backOff()
  }

  /** Backoff on top of the alarm, which is the only thing that survives an evicted worker. */
  private backOff(): void {
    this.failures += 1
    this.nextAttemptAt = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS)
  }

  private watchSilence(): void {
    clearTimeout(this.silence)
    this.silence = setTimeout(() => this.close(), this.heartbeatMs * SILENCE_FACTOR)
  }

  private send(socket: WebSocket, frame: ExtensionFrame | Record<string, unknown>): void {
    if (socket.readyState !== 1) return
    try {
      socket.send(JSON.stringify(frame))
    } catch {
      // A socket that died between the check and the send is the close handler's problem.
    }
  }
}

/**
 * Holds every attachment: at most one relay, and one per live bridge, because a bridge is per MCP
 * client — Claude Code and Cursor each spawn their own and both must reach the browser.
 */
class Manager {
  readonly limiter = new RateLimiter()
  readonly audit = new AuditLog()
  expose: ExposeLists = { local: [], remote: [] }
  bridge: BridgePairing = {}
  private readonly attachments = new Map<string, Attachment>()
  private relay: RelayPairing | null = null
  /**
   * The endpoint token a relay answered 1008 to. In memory rather than in storage: a worker that
   * has been evicted and respawned should try once more, in case the relay was merely restarting,
   * and one notification per worker lifetime is not a storm. A token written by the connect page
   * differs from this one, so a re-pairing dials immediately.
   */
  private refusedToken: string | null = null
  /**
   * A relay refusal waiting to be explained to the user, held until the next tick.
   *
   * The relay closes the old socket 1008 the moment it answers `POST /rotate`, which the user just
   * asked for, and that close routinely beats the connect page's write of the new token to
   * storage. Judged at the close it reads as a revocation; judged one tick later — with the write
   * certainly landed — a rotate is simply a token that is no longer the stored one. Deciding late
   * costs a notification up to 30 seconds; deciding early cries wolf every single rotate.
   */
  private pendingRefusal: string | null = null

  constructor(private readonly deps: AttachDeps) {}

  get bridgePaired(): boolean {
    return typeof this.bridge.secret === 'string' && this.bridge.secret.length > 0
  }

  /** Whether anything at all is up right now — what the connect page shows. */
  get connected(): boolean {
    return [...this.attachments.values()].some((attachment) => attachment.connected)
  }

  private async load(): Promise<void> {
    const stored = await chrome.storage.local.get([RELAY_KEY, BRIDGE_KEY, EXPOSE_KEY])
    this.relay = (stored[RELAY_KEY] as RelayPairing | undefined) ?? null
    this.bridge = (stored[BRIDGE_KEY] as BridgePairing | undefined) ?? {}
    const expose = stored[EXPOSE_KEY] as Partial<ExposeLists> | undefined
    this.expose = { local: expose?.local ?? [], remote: expose?.remote ?? [] }
  }

  /**
   * Dials everything that is configured and not already up. Idempotent, and the alarm's job.
   *
   * Storage is re-read every tick rather than cached: the connect page (T-015.10) writes the relay
   * pairing from another context entirely, and a manager that read it once at worker start would
   * ignore a link the user made 20 seconds ago until Chrome next evicted the worker.
   */
  async tick(): Promise<void> {
    await this.load()
    this.judgeRefusal()
    const relay = this.relay && this.relay.token !== this.refusedToken ? relayTarget(this.relay) : null
    this.drop('relay:', relay?.key)
    if (relay) this.attachment(relay).connect()
    if (this.bridge.blocked || (!this.bridgePaired && !this.bridge.code)) return this.drop('bridge:')
    for (const port of BRIDGE_PORT_RANGE) this.attachment(bridgeTarget(port)).connect()
  }

  /** T-015.9 — exempt (or re-gate) one tool's results at one trust level. */
  async setExposed(trust: Trust, tool: string, allow: boolean): Promise<void> {
    const current = new Set(this.expose[trust])
    if (allow) current.add(tool)
    else current.delete(tool)
    this.expose = { ...this.expose, [trust]: [...current].sort() }
    await chrome.storage.local.set({ [EXPOSE_KEY]: this.expose })
  }

  pushSurface(): void {
    for (const attachment of this.attachments.values()) attachment.pushSurface()
  }

  async pinBridge(secret: string): Promise<void> {
    if (this.bridge.secret === secret) return
    this.bridge = { secret }
    await chrome.storage.local.set({ [BRIDGE_KEY]: this.bridge })
  }

  /**
   * A host said 1008. For the bridge that means the code was wrong or the credential was rebuilt
   * without us; either way another dial cannot help, so bridge dialling stops until the user
   * supplies a fresh code. For the relay it means the token is dead and the link must be remade.
   */
  async refused(target: Target): Promise<void> {
    if (target.kind === 'relay') {
      this.refusedToken = target.token
      this.pendingRefusal = target.token
      this.drop('relay:')
      return
    }
    this.bridge = { blocked: true }
    await chrome.storage.local.set({ [BRIDGE_KEY]: this.bridge })
    this.drop('bridge:')
    this.deps.notify(
      'douze-bridge-refused',
      'Douze could not pair with the app on this computer',
      'Restart the app that runs Douze, then open the extension and enter the pairing code it prints.',
    )
  }

  /** T-015.12 — the user typed the code the bridge printed. Clears a previous refusal. */
  async pair(code: string): Promise<void> {
    this.bridge = { code: code.trim() }
    await chrome.storage.local.set({ [BRIDGE_KEY]: this.bridge })
    this.drop('bridge:')
    await this.tick()
  }

  /**
   * Says something about a relay refusal only if the token that was refused is still the one in
   * storage. A rotate or a stop replaced it, and the user knows: they did it. Runs on the fresh
   * read at the top of `tick`, so a worker Chrome evicted between the close and the alarm simply
   * dials again, is refused again, and asks on the tick after that.
   */
  private judgeRefusal(): void {
    const refused = this.pendingRefusal
    if (!refused) return
    this.pendingRefusal = null
    if (this.relay?.token !== refused) return
    this.deps.notify(
      'douze-relay-refused',
      'Douze lost its link',
      'The link you shared with your hosted assistant is no longer valid. Open Douze and get a new one.',
    )
  }

  private attachment(target: Target): Attachment {
    const existing = this.attachments.get(target.key)
    if (existing) return existing
    const created = new Attachment(target, this.deps, this)
    this.attachments.set(target.key, created)
    return created
  }

  /** Closes every attachment under `prefix` except `keep`, which is the one still wanted. */
  private drop(prefix: string, keep?: string): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before deleting from the map
    for (const [key, attachment] of [...this.attachments]) {
      if (!key.startsWith(prefix) || key === keep) continue
      attachment.close()
      this.attachments.delete(key)
    }
  }
}

/**
 * The key carries everything about the pairing that policy or the handshake depends on, so a
 * rotated token or a newly-granted write opt-in is a *different* attachment: the old socket is
 * closed and a fresh one dials and pushes the surface that opt-in implies. An attachment that
 * kept its identity across a config change would keep serving the old one until it happened to
 * drop.
 */
const relayTarget = (pairing: RelayPairing): Target => ({
  kind: 'relay',
  key: `relay:${pairing.url}|${pairing.token}|${pairing.allow_writes}`,
  url: `${pairing.url.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`,
  token: pairing.token,
  allowWrites: pairing.allow_writes,
})

/** `127.0.0.1`, never `localhost` — `localhost` can resolve to ::1 first and miss the listener. */
const bridgeTarget = (port: number): Target => ({
  kind: 'bridge',
  key: `bridge:${port}`,
  url: `ws://127.0.0.1:${port}/ws`,
  port,
})

/**
 * Starts the attachment client and hands back the handles the worker needs.
 *
 * Called at the TOP LEVEL of the worker, synchronously, and the alarm is created every time:
 * `chrome.alarms.create` with the same name replaces the existing alarm, and a worker Chrome
 * respawned has no timers of its own at all. Without this the socket stays down for as long as the
 * worker stays evicted, which is exactly the state the 40-second wake grace exists to ride out.
 */
export function startAttachments(deps: AttachDeps): {
  tick: () => Promise<void>
  pushSurface: () => void
  connected: () => boolean
  pair: (code: string) => Promise<void>
  setExposed: (trust: Trust, tool: string, allow: boolean) => Promise<void>
} {
  const created = new Manager(deps)
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM) void created.tick()
  })
  return {
    tick: () => created.tick(),
    pushSurface: () => created.pushSurface(),
    connected: () => created.connected,
    pair: (code) => created.pair(code),
    setExposed: (trust, tool, allow) => created.setExposed(trust, tool, allow),
  }
}

/** The audit surface `douze status` used to print, for the popup and the connect page. */
export const recentCalls = (limit?: number): Promise<AuditEntry[]> => AuditLog.recent(limit)

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const version = (): string => {
  try {
    return chrome.runtime.getManifest().version
  } catch {
    return '0.0.0'
  }
}

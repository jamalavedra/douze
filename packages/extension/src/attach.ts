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
import { AuditLog, RateLimiter, attachedSurface, runToolCall, siteOf, type AuditEntry } from './guards.js'
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
/** WO-016 — the shortest gap between two "your assistant changed something" notifications. */
const WRITE_NOTICE_MS = 60_000

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
 * put on the wire: both are only ever HMAC keys.
 *
 * Nothing else belongs here, and in particular a refusal does not: this object is only ever written
 * by the user typing a code or by a bridge that PROVED itself, never by a peer that merely closed a
 * socket (see `refused`).
 */
export interface BridgePairing {
  secret?: string
  code?: string
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
    const salt = payload['salt']
    const key = await this.handshakeKey(salt)
    if (!key) return
    // `''` unless the far side is running on a code: an unsalted transcript and a salted one are
    // different strings, so the two ends cannot half-agree about which they are proving.
    const transcript = {
      port: this.target.port,
      extensionNonce: this.nonce,
      bridgeNonce,
      salt: typeof salt === 'string' ? salt : '',
    }
    const expected = await proof(key, { role: 'bridge', ...transcript })
    if (!proofMatches(expected, payload['proof'])) return
    if (this.socket !== socket || socket.readyState !== 1) return
    this.verified = true
    this.watchSilence()
    this.send(socket, { type: 'bridge.proof', proof: await proof(key, { role: 'extension', ...transcript }) })
  }

  /**
   * `sha256(secret)` once paired — what the bridge stores — or the stretched code before that,
   * against the salt the bridge minted for its code. A code with no salt on the challenge is not
   * derivable: a bridge running on a code always sends one.
   */
  private async handshakeKey(salt: unknown): Promise<CryptoKey | null> {
    const pairing = this.manager.bridge
    if (pairing.secret) return secretHashKey(await sha256Hex(pairing.secret))
    if (!pairing.code || !isNonce(salt)) return null
    return this.manager.stretch(pairing.code, salt)
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
    // WO-016 — only a call that actually ran, and only from a hosted assistant. A refusal changed
    // nothing on the target, and notifying on one would hand any host that can reach this socket a
    // way to fill the user's notification centre by asking for tools it knows will be refused.
    if (trust === 'remote' && outcome.error === undefined) this.manager.noteRemoteWrite(name)
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
   * Bridge ports that answered 1008, held **in memory and per port**. Nothing about a refusal is
   * written down: a 1008 can come from any process that got to a loopback port first, and none of
   * them has proved anything. Per port, because five ports are dialled and a squatter on one must
   * not silence the four a real bridge might be on; in memory, because a worker Chrome respawns
   * should try once more in case that port has a real bridge on it now.
   */
  private readonly refusedBridges = new Set<string>()
  /**
   * The stretched pairing code, kept for as long as the code and salt behind it hold.
   *
   * `codeKey` is 600 000 PBKDF2 rounds and five ports are dialled on every 30-second alarm, so a
   * derivation per socket would have a pending code cost ~1.5 s of worker CPU per tick. This is the
   * mirror of the cache the bridge keeps for exactly the same reason.
   */
  private stretched: { code: string; salt: string; key: Promise<CryptoKey> } | null = null
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
  /** When the last remote-write notice went out, and how many writes have happened since. */
  private writeNotice = { at: 0, since: 0 }

  constructor(private readonly deps: AttachDeps) {}

  get bridgePaired(): boolean {
    return typeof this.bridge.secret === 'string' && this.bridge.secret.length > 0
  }

  /** Whether anything at all is up right now — what the connect page shows. */
  get connected(): boolean {
    return [...this.attachments.values()].some((attachment) => attachment.connected)
  }

  /** Whether a bridge that proved itself is attached right now. */
  private get bridgeUp(): boolean {
    return [...this.attachments.values()].some(
      (attachment) => attachment.target.kind === 'bridge' && attachment.connected,
    )
  }

  /**
   * What the connect page calls a refused bridge: a port said 1008 and nothing else took its place.
   * Not stored, so it is gone when the worker is — which is right for a claim made by a peer that
   * proved nothing, and it means the page stops saying "refused" the moment a real bridge attaches.
   */
  get bridgeRefused(): boolean {
    return this.refusedBridges.size > 0 && !this.bridgeUp
  }

  /**
   * The relay answered 1008 for the token in storage: it has forgotten this endpoint, and no
   * amount of waiting brings it back. `tick` stops dialling a refused token (see the guard in
   * `targets`), so without this the connect page went on saying Douze "keeps trying on its own"
   * about a link that was dead and a socket nothing was retrying — the one state where the page's
   * reassuring sentence was the opposite of the truth. A relay that restarts forgets every
   * endpoint it ever handed out, so this is not an edge case; it is every user, every deploy.
   */
  get relayRefused(): boolean {
    // `refusedToken` is `string | null`, so no relay stored answers false rather than matching.
    return this.relay?.token === this.refusedToken
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
    if (!this.bridgePaired && !this.bridge.code) return this.drop('bridge:')
    for (const port of BRIDGE_PORT_RANGE) {
      const target = bridgeTarget(port)
      if (!this.refusedBridges.has(target.key)) this.attachment(target).connect()
    }
  }

  /** The stretched code, derived at most once per (code, salt) pair. See `stretched`. */
  stretch(code: string, salt: string): Promise<CryptoKey> {
    if (this.stretched?.code === code && this.stretched.salt === salt) return this.stretched.key
    const key = codeKey(code, salt)
    this.stretched = { code, salt, key }
    return key
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

  /**
   * WO-016 — a hosted assistant just changed something in one of the user's accounts, and until
   * this nothing told them. Writes are approved once, at review time, and callable for as long as
   * the link lives; the audit ring records every call and is seen only by someone who opens a page.
   *
   * Non-blocking on purpose. A confirmation prompt per call is the control that gets switched off
   * in the first week, and a user who has turned it off is worse protected than one who sees a
   * notification seconds after a write they did not expect — which is the point: not consent, but
   * the chance to notice and pull the link before the loop runs a hundred more.
   *
   * **Collapsed by time, not by count**: the first write notifies at once and the next 60 seconds
   * of them are counted instead, so an agent in a loop produces one notice a minute naming how many
   * ran, and the fixed notification id means Chrome replaces the old one rather than stacking. The
   * ceiling is honest: a burst that stops inside the window has its tail reported by the next write
   * rather than by a timer, because a timer in a service worker does not survive eviction.
   */
  noteRemoteWrite(tool: string): void {
    const entry = this.deps.surface().find((candidate) => candidate.qualified_name === tool)
    if (!entry || entry.tool.side_effect === 'read') return
    this.writeNotice.since += 1
    const now = Date.now()
    if (now - this.writeNotice.at < WRITE_NOTICE_MS) return
    const collapsed = this.writeNotice.since - 1
    this.writeNotice = { at: now, since: 0 }
    this.deps.notify(
      'douze-remote-write',
      'Your hosted assistant changed something',
      `It ran ${tool} on ${siteOf(entry.base_url)}` +
        (collapsed === 0 ? '.' : `, and ${collapsed} more changes since the last notice.`) +
        ' Open Douze to see every call it has made.',
    )
  }

  async pinBridge(secret: string): Promise<void> {
    if (this.bridge.secret === secret) return
    this.bridge = { secret }
    await chrome.storage.local.set({ [BRIDGE_KEY]: this.bridge })
  }

  /**
   * A host said 1008.
   *
   * For the relay that is authenticated — the token was presented over TLS to the address the user
   * configured — so it means the token is dead and the link must be remade.
   *
   * For a bridge it is **the word of a peer that has proved nothing**: binding one of 8912–8916
   * takes no privilege, and an unverified close is exactly what a squatter can produce on demand.
   * So it costs that one port and nothing else. It must never touch storage: wiping the pinned
   * secret here would let any local process unpair the user's real bridge with a single close, and
   * a paired bridge prints no new code to recover with. It is also ordinary traffic — two clients
   * each spawn a bridge, and the one the user did not type a code for refuses on its own deadline
   * seconds after the other paired.
   */
  async refused(target: Target): Promise<void> {
    if (target.kind === 'relay') {
      this.refusedToken = target.token
      this.pendingRefusal = target.token
      this.drop('relay:')
      return
    }
    this.refusedBridges.add(target.key)
    this.drop(target.key)
    // Only when no bridge is actually up: with a working one attached, this is a port the user has
    // no reason to hear about. With none, it is the one signal that says the code did not take — a
    // wrong code produces exactly this, because the extension goes quiet on a proof it cannot
    // verify and the bridge closes the socket a moment later.
    if (this.bridgeUp) return
    this.deps.notify(
      'douze-bridge-refused',
      'Douze could not pair with the app on this computer',
      'Check the pairing code the app printed and enter it again. If it has expired, restart the app for a fresh one.',
    )
  }

  /** T-015.12 — the user typed the code the bridge printed. Clears a previous refusal. */
  async pair(code: string): Promise<void> {
    this.bridge = { code: code.trim() }
    await chrome.storage.local.set({ [BRIDGE_KEY]: this.bridge })
    this.refusedBridges.clear()
    this.drop('bridge:')
    await this.tick()
  }

  /**
   * The other half of `pair`, which the connect page could do and never undo: an app paired once
   * kept `local` trust — every write and every destructive tool — for the life of the install,
   * with nothing anywhere that withdrew it.
   *
   * The socket is closed here rather than left to the alarm, because the direction that matters is
   * off: a bridge the user has just unpaired must not go on running destructive tools for the 30
   * seconds until the next tick. Forgetting the secret is what makes it a real revocation — the
   * bridge keeps its own copy, so re-pairing means typing the code it prints again.
   */
  async unpair(): Promise<void> {
    this.bridge = {}
    await chrome.storage.local.remove(BRIDGE_KEY)
    this.drop('bridge:')
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
      'The link you shared with your hosted assistant is no longer valid. Open Douze, choose Stop sharing, then Connect, and paste the new link in.',
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
  bridgeRefused: () => boolean
  relayRefused: () => boolean
  pair: (code: string) => Promise<void>
  unpair: () => Promise<void>
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
    bridgeRefused: () => created.bridgeRefused,
    relayRefused: () => created.relayRefused,
    pair: (code) => created.pair(code),
    unpair: () => created.unpair(),
    setExposed: (trust, tool, allow) => created.setExposed(trust, tool, allow),
  }
}

/** The audit surface `douze status` used to print, for the popup and the connect page. */
export const recentCalls = (limit?: number): Promise<AuditEntry[]> => AuditLog.recent(limit)

/** …and the only thing that removes it, from the data page. */
export const clearCalls = (): Promise<void> => AuditLog.clear()

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

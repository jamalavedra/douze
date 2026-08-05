import { HEARTBEAT_MS, type ClientMessage, type ServerMessage } from '@recon/shared'

/**
 * ADR-003 — the extension dials recond; recond never dials the browser. Chrome 116+ resets the
 * service-worker idle timer on every WebSocket send and receive, so recond's 20-second
 * heartbeat is what keeps the worker alive during a recording.
 */

/** Full-jitter exponential backoff, capped. Full jitter is what avoids a thundering herd. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const cap = 30_000
  return Math.floor(random() * Math.min(cap, 1000 * 2 ** Math.min(attempt, 5)))
}

/**
 * T-001.4 — exchanges captured while the socket is down are buffered rather than dropped.
 * Bounded so a long disconnect cannot grow without limit; the oldest entries go first.
 */
export class Outbox {
  private queue: ClientMessage[] = []

  constructor(private readonly limit = 2000) {}

  push(message: ClientMessage): void {
    this.queue.push(message)
    if (this.queue.length > this.limit) this.queue.splice(0, this.queue.length - this.limit)
  }

  /** Sends while `send` keeps succeeding; a refusal leaves the remainder queued in order. */
  drain(send: (message: ClientMessage) => boolean): number {
    let sent = 0
    while (this.queue.length) {
      const next = this.queue[0] as ClientMessage
      if (!send(next)) break
      this.queue.shift()
      sent += 1
    }
    return sent
  }

  get size(): number {
    return this.queue.length
  }

  snapshot(): ClientMessage[] {
    return [...this.queue]
  }

  restore(messages: ClientMessage[]): void {
    this.queue = [...messages, ...this.queue].slice(-this.limit)
  }
}

export interface SocketOptions {
  port: number
  token: string
  version: string
  onMessage: (message: ServerMessage) => void
  onStateChange?: (connected: boolean) => void
}

/** `127.0.0.1`, never `localhost` — `localhost` can resolve to ::1 first and miss the daemon. */
export const socketUrl = (port: number, token: string): string =>
  `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`

export class DaemonSocket {
  private socket: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  readonly outbox = new Outbox()

  constructor(private options: SocketOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  configure(options: SocketOptions): void {
    this.options = options
  }

  /** Idempotent: an alarm firing during a healthy connection is a cheap no-op. */
  connect(): void {
    const state = this.socket?.readyState
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return
    if (!this.options.token) return

    let socket: WebSocket
    try {
      socket = new WebSocket(socketUrl(this.options.port, this.options.token))
    } catch {
      return
    }
    this.socket = socket

    socket.addEventListener('open', () => {
      this.options.onStateChange?.(true)
      this.send({ type: 'hello', token: this.options.token, extension_version: this.options.version })
      this.flush()
      this.stopPing()
      this.pingTimer = setInterval(() => {
        if (this.connected) this.send({ type: 'pong' })
        else this.stopPing()
      }, HEARTBEAT_MS)
    })

    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        this.options.onMessage(JSON.parse(String(event.data)) as ServerMessage)
      } catch {
        /* recond only ever sends JSON; anything else is not ours to interpret */
      }
    })

    socket.addEventListener('close', () => {
      this.stopPing()
      if (this.socket === socket) this.socket = null
      this.options.onStateChange?.(false)
    })

    socket.addEventListener('error', () => {
      try {
        socket.close()
      } catch {
        /* already closing */
      }
    })
  }

  /** Queues when the socket is down so nothing captured offline is lost. */
  send(message: ClientMessage): void {
    if (!this.trySend(message)) this.outbox.push(message)
  }

  flush(): number {
    return this.outbox.drain((message) => this.trySend(message))
  }

  private trySend(message: ClientMessage): boolean {
    if (!this.connected) return false
    try {
      this.socket?.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  close(): void {
    this.stopPing()
    try {
      this.socket?.close()
    } catch {
      /* already closed */
    }
    this.socket = null
  }
}

import { DouzeError, type RelayResponse } from '@douze/shared'
import type { SurfaceTool } from '@douze/douzed'
import { DaemonHttpError, type DaemonClient } from './daemon-client.js'
import { fromDaemon, type DaemonErrorBody } from './errors.js'
import { shapeResult, type Shaped } from './shape.js'

/** AC-CON-003.1 — the interval at which a still-running call reports progress. */
export const PROGRESS_INTERVAL_MS = 60_000

/**
 * AC-CON-003.2 — the ceiling a call is cancelled at. Five minutes matches the MV3 service-worker
 * cap the extension executes under, so nothing waits on a browser that has already given up.
 */
export const DEFAULT_CEILING_MS = 300_000

export interface CallResult extends Shaped {
  status: number
  duration_ms: number
}

export interface CallOptions {
  /** Called at every `PROGRESS_INTERVAL_MS` while the call is outstanding. */
  onProgress?: (elapsedMs: number) => void | Promise<void>
  ceilingMs?: number
}

/**
 * #RelayClient — builds the call, waits it out, and shapes the answer. It owns none of the
 * guards: rate limiting, destructive confirmation, and degradation all live in douzed so they
 * cannot be bypassed by calling the daemon directly (blueprint 3.3).
 */
export class RelayClient {
  constructor(private readonly daemon: DaemonClient) {}

  async call(surface: SurfaceTool, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallResult> {
    const ceiling = options.ceilingMs ?? Number(process.env['DOUZE_CALL_CEILING_MS'] ?? DEFAULT_CEILING_MS)
    const started = Date.now()
    const ticker = options.onProgress
      ? setInterval(() => void options.onProgress?.(Date.now() - started), PROGRESS_INTERVAL_MS)
      : undefined

    try {
      const response = await withCeiling(
        this.post(surface, args, ceiling),
        ceiling,
        () =>
          new DouzeError(
            'timeout',
            `Tool "${surface.qualified_name}" was cancelled after ${Math.round((Date.now() - started) / 1000)}s without returning; the configured ceiling is ${Math.round(ceiling / 1000)}s.`,
            { tool: surface.qualified_name, elapsed_ms: Date.now() - started, ceiling_ms: ceiling },
          ),
      )
      return {
        status: response.status ?? 0,
        duration_ms: response.duration_ms,
        ...shapeResult(response.body, {
          primary_payload_path: surface.tool.response.primary_payload_path,
          raw: args['raw'] === true,
        }),
      }
    } finally {
      clearInterval(ticker)
    }
  }

  private async post(surface: SurfaceTool, args: Record<string, unknown>, ceiling: number): Promise<RelayResponse> {
    try {
      return await this.daemon.request<RelayResponse>(
        `/relay/${encodeURIComponent(surface.recipe)}/${encodeURIComponent(surface.tool.name)}`,
        { method: 'POST', body: JSON.stringify({ args, timeout_ms: ceiling }) },
      )
    } catch (error) {
      // AC-CON-004.* — every daemon failure becomes one of the named codes, and none is retried.
      if (error instanceof DaemonHttpError) {
        throw fromDaemon(error.body as DaemonErrorBody, error.status, surface.qualified_name)
      }
      throw error
    }
  }
}

function withCeiling<T>(work: Promise<T>, ms: number, onTimeout: () => DouzeError): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms)
    }),
  ])
}

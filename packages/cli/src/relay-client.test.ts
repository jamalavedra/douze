import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DouzeError } from '@douze/shared'
import type { SurfaceTool } from '@douze/douzed'
import { DaemonHttpError, type DaemonClient } from './daemon-client.js'
import { PROGRESS_INTERVAL_MS, RelayClient } from './relay-client.js'

const surface: SurfaceTool = {
  qualified_name: 'jira_list',
  recipe: 'jira',
  base_url: 'https://jira.test',
  tool: {
    name: 'list',
    description: 'List issues',
    side_effect: 'read',
    confidence: 0.9,
    observations: 3,
    approved: true,
    request: { method: 'GET', path: '/issues', input_schema: {}, headers: {} },
    response: { output_schema: {}, primary_payload_path: '$.data' },
    fixtures: [],
    flags: { sparse: false, derived_name: false, unverified: false, degraded: false, user_edited: [], suggestions: {} },
  },
  credential_source: [{ kind: 'cookie' }],
  degraded: false,
}

const daemonWith = (request: DaemonClient['request']): DaemonClient => ({ request }) as unknown as DaemonClient

describe('RelayClient', () => {
  it('posts to /relay/:recipe/:tool and shapes the response (AC-RUN-004.1)', async () => {
    const request = vi.fn().mockResolvedValue({
      id: '1',
      ok: true,
      status: 200,
      headers: {},
      body: { meta: {}, data: [{ id: 'o-1' }] },
      duration_ms: 12,
      redirected_to_login: false,
    })
    const result = await new RelayClient(daemonWith(request)).call(surface, { status: 'open' })

    expect(request).toHaveBeenCalledWith('/relay/jira/list', {
      method: 'POST',
      body: JSON.stringify({ args: { status: 'open' }, timeout_ms: 300_000 }),
    })
    expect(result.data).toEqual([{ id: 'o-1' }])
    expect(result.status).toBe(200)
  })

  it('honours raw by skipping the payload path', async () => {
    const body = { meta: { page: 1 }, data: [{ id: 'o-1' }] }
    const request = vi.fn().mockResolvedValue({ id: '1', ok: true, status: 200, headers: {}, body, duration_ms: 1, redirected_to_login: false })
    const result = await new RelayClient(daemonWith(request)).call(surface, { raw: true })
    expect(result.data).toEqual(body)
  })

  it('translates a daemon error body without retrying (AC-CON-004.4)', async () => {
    const error = new DaemonHttpError(502)
    error.body = { error: 'extension_disconnected', message: 'not connected', target: 'https://jira.test' }
    const request = vi.fn().mockRejectedValue(error)

    await expect(new RelayClient(daemonWith(request)).call(surface, {})).rejects.toMatchObject({
      code: 'extension_disconnected',
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('long-call survival (REQ-CON-003)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('emits progress every 60 seconds until the call completes (AC-CON-003.1)', async () => {
    let settle: (value: unknown) => void = () => undefined
    const request = vi.fn().mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const onProgress = vi.fn()

    const call = new RelayClient(daemonWith(request)).call(surface, {}, { onProgress, ceilingMs: 600_000 })

    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 3 + 1000)
    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress.mock.calls.map(([ms]) => Math.round((ms as number) / 60_000))).toEqual([1, 2, 3])

    settle({ id: '1', ok: true, status: 200, headers: {}, body: { data: 'x' }, duration_ms: 1, redirected_to_login: false })
    await call
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 2)
    expect(onProgress).toHaveBeenCalledTimes(3)
  })

  it('cancels at the ceiling with a timeout naming the tool and elapsed time (AC-CON-003.2)', async () => {
    const request = vi.fn().mockReturnValue(new Promise(() => undefined))
    const call = new RelayClient(daemonWith(request)).call(surface, {}, { ceilingMs: 120_000 })
    const assertion = expect(call).rejects.toBeInstanceOf(DouzeError)

    await vi.advanceTimersByTimeAsync(120_001)
    await assertion

    await call.catch((error: DouzeError) => {
      expect(error.code).toBe('timeout')
      expect(error.message).toContain('jira_list')
      expect(error.message).toContain('120s')
      expect(error.detail).toMatchObject({ tool: 'jira_list', ceiling_ms: 120_000 })
    })
  })
})

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DouzeError, type Recipe } from '@douze/shared'
import { buildRequest } from './relay.js'
import type { SurfaceTool } from './registry.js'

const run = promisify(execFile)

const SERVICE = 'douze-headless'

/**
 * AC-EXE-004.3 — every headless invocation says so. This is the degraded path and must never
 * be reachable by implicit fallback from the relay (WO-013 out-of-scope note, AC-CON-004.4).
 */
export const DEGRADED_NOTICE =
  'Executed via Headless Mode — the degraded path. Requests were issued directly from douzed ' +
  'using a stored session rather than through your signed-in browser.'

/**
 * AC-EXE-004.1 — the session lives in the OS keychain; configuration holds only a reference.
 * macOS `security` is used directly so douzed ships without a native keychain dependency.
 */
export class Keychain {
  constructor(private readonly service = SERVICE) {}

  async set(account: string, value: string): Promise<void> {
    await run('security', ['add-generic-password', '-U', '-s', this.service, '-a', account, '-w', value])
  }

  async get(account: string): Promise<string | null> {
    try {
      const { stdout } = await run('security', ['find-generic-password', '-s', this.service, '-a', account, '-w'])
      return stdout.trim()
    } catch {
      return null
    }
  }

  async clear(account: string): Promise<void> {
    try {
      await run('security', ['delete-generic-password', '-s', this.service, '-a', account])
    } catch {
      // Already absent is the desired end state.
    }
  }
}

export interface HeadlessResult {
  status: number
  headers: Record<string, string>
  body: unknown
  notice: string
}

/**
 * AC-EXE-004.2 — issues the request directly, and on a 401 applies the recipe's declared refresh
 * endpoint exactly once before retrying. On refresh failure the stored session is cleared and the
 * user is told that browser relay is required to re-establish it (AC-EXE-004.4).
 */
export async function executeHeadless(
  surface: SurfaceTool,
  recipe: Recipe,
  args: Record<string, unknown>,
  keychain = new Keychain(),
): Promise<HeadlessResult> {
  const account = recipe.auth.keychain_ref
  if (recipe.auth.mode !== 'headless' || !account) {
    throw new DouzeError(
      'relay_unreachable',
      `Headless Mode is not enabled for "${recipe.name}". Enable it explicitly with \`douze headless enable ${recipe.name}\`, or start Chrome so the browser relay can run.`,
      { recipe: recipe.name },
    )
  }

  const session = await keychain.get(account)
  if (!session) {
    throw new DouzeError(
      'session_expired',
      `No stored session for "${recipe.name}". Browser relay is required to re-establish it: open Chrome, sign in, and re-enable Headless Mode.`,
      { recipe: recipe.name },
    )
  }

  let response = await issue(surface, args, session)

  if (response.status === 401 && recipe.auth.refresh_endpoint) {
    const refreshed = await refresh(recipe, session)
    if (refreshed) {
      await keychain.set(account, refreshed)
      // A single retry, never a loop.
      response = await issue(surface, args, refreshed)
    }
    if (!refreshed || response.status === 401) {
      await keychain.clear(account)
      throw new DouzeError(
        'session_expired',
        `The stored session for "${recipe.name}" could not be refreshed and has been cleared. Browser relay is required to re-establish it.`,
        { recipe: recipe.name },
      )
    }
  }

  return { ...response, notice: DEGRADED_NOTICE }
}

async function issue(
  surface: SurfaceTool,
  args: Record<string, unknown>,
  session: string,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const descriptor = buildRequest(surface, args)
  const response = await fetch(descriptor.url, {
    method: descriptor.method,
    headers: { ...descriptor.headers, cookie: session },
    ...(descriptor.body === undefined ? {} : { body: JSON.stringify(descriptor.body) }),
    redirect: 'manual',
  })
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.json().catch(() => undefined),
  }
}

async function refresh(recipe: Recipe, session: string): Promise<string | null> {
  try {
    const response = await fetch(new URL(recipe.auth.refresh_endpoint!, recipe.target.base_url), {
      method: 'POST',
      headers: { cookie: session },
    })
    if (!response.ok) return null
    const setCookie = response.headers.get('set-cookie')
    return setCookie ?? session
  } catch {
    return null
  }
}

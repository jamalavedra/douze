import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_ORIGIN, REPO } from './harness.js'

/**
 * Builds the extension with the fixture origin baked into `host_permissions`.
 * `chrome.permissions.request` needs a user gesture and Playwright cannot click Chrome's own
 * permission bubble, so the e2e build declares the one origin the suite talks to. The shipped
 * build keeps `optional_host_permissions` and grants per target at record time (TR-1).
 */
export default function globalSetup(): void {
  execFileSync('pnpm', ['--filter', '@douze/extension', 'build'], {
    cwd: REPO,
    env: { ...process.env, DOUZE_TEST_ORIGIN: FIXTURE_ORIGIN },
    stdio: 'inherit',
  })
  const manifest = join(REPO, 'packages/extension/dist/manifest.json')
  if (!existsSync(manifest)) throw new Error(`extension build produced no manifest at ${manifest}`)
}

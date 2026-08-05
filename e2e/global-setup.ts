import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './harness.js'

/**
 * Builds the extension with the fixture origin baked into `host_permissions`.
 * `chrome.permissions.request` needs a user gesture and Playwright cannot click Chrome's own
 * permission bubble, so the e2e build declares the one origin the suite talks to. The shipped
 * build keeps `optional_host_permissions` and grants per target at record time (TR-1).
 */
export default function globalSetup(): void {
  const origin = process.env['RECON_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:4180'
  execFileSync('pnpm', ['--filter', '@recon/extension', 'build'], {
    cwd: REPO,
    env: { ...process.env, RECON_TEST_ORIGIN: origin },
    stdio: 'inherit',
  })
  const manifest = join(REPO, 'packages/extension/dist/manifest.json')
  if (!existsSync(manifest)) throw new Error(`extension build produced no manifest at ${manifest}`)
}

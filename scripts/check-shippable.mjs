import { readFileSync } from 'node:fs'

/**
 * The e2e harness rewrites `dist/manifest.json` to bake the fixture origin into `host_permissions`,
 * because `chrome.permissions.request` needs a user gesture Playwright cannot produce. That build
 * is not shippable: it grants a site standing access that a real install asks for per target and
 * only when the user says yes. `release:local` rebuilds first so it is safe, but `pack:extension`
 * on its own would happily zip whatever a test run left behind — which is the copy a human uploads.
 *
 * So the pack step refuses instead of trusting whoever ran what last.
 */
const manifest = JSON.parse(readFileSync('packages/extension/dist/manifest.json', 'utf8'))
const granted = manifest.host_permissions ?? []

if (granted.length > 0) {
  process.stderr.write(
    `refusing to package: dist/manifest.json grants ${JSON.stringify(granted)} up front.\n` +
      `A test run left this build behind. Run \`pnpm build\` and package that.\n`,
  )
  process.exit(1)
}

import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

/**
 * WO-015 T-015.3 — the extension bundles this entry into an MV3 service worker, where a `node:*`
 * import is a build failure rather than something you find in review. esbuild with
 * `platform: 'browser'` refuses to resolve a Node builtin, so bundling the entry IS the check,
 * across the whole transitive graph including `@douze/shared`.
 *
 * Verified to fail: adding `import { homedir } from 'node:os'` to `candidates.ts` produces
 * `Could not resolve "node:os"` and this test goes red.
 */
it('bundles for the browser with no node builtin in the graph', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./browser.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  })
  expect(result.errors).toEqual([])
  expect(result.outputFiles[0]?.text).not.toMatch(/require\("node:/)
}, 30_000)

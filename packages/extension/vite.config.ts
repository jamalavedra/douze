import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * `chrome.permissions.request` needs a real user gesture and opens a modal no test driver can
 * dismiss — verified in Helium: from the service worker it throws "must be called during a user
 * gesture", and from an extension page it hangs on the prompt. Without the grant, content-script
 * registration silently no-ops and `executeScript` throws. So the e2e build bakes the fixture
 * origin into `host_permissions`; production builds set nothing and ask the user at record time.
 */
const testOrigin = (): import('vite').Plugin => ({
  name: 'recon-test-origin',
  closeBundle() {
    const origin = process.env['RECON_TEST_ORIGIN']
    if (!origin) return
    const file = resolve(import.meta.dirname, 'dist/manifest.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { host_permissions: string[] }
    manifest.host_permissions = origin.split(',').map((o) => `${o.trim()}/*`)
    writeFileSync(file, JSON.stringify(manifest, null, 2))
  },
})

/**
 * `interceptor` and `bridge` are injected as classic content scripts, so they must bundle to
 * self-contained files with no import statements. They deliberately import nothing at runtime,
 * which is what keeps the bundler from splitting a chunk out of them; `smoke.mjs` asserts it.
 */
export default defineConfig({
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [testOrigin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, 'src/background.ts'),
        interceptor: resolve(import.meta.dirname, 'src/interceptor.ts'),
        bridge: resolve(import.meta.dirname, 'src/bridge.ts'),
        popup: resolve(import.meta.dirname, 'src/popup.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})

import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

/**
 * The CLI ships as one file. AC-CON-001.3 — the `.mcpb` runs on the Node inside Claude Desktop
 * with no install step, so the bundle cannot rely on a `node_modules` tree being present; and
 * `recon --mcp` has to be a single path a config entry can point at.
 */
export default defineConfig({
  build: {
    ssr: 'src/bin.ts',
    outDir: 'dist',
    target: 'node22',
    minify: false,
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      // Optional native accelerators for `ws`; absent by design and resolved at runtime.
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'bufferutil', 'utf-8-validate'],
      output: { format: 'es', entryFileNames: 'index.js', chunkFileNames: '[name].js' },
    },
  },
  ssr: { noExternal: true },
})

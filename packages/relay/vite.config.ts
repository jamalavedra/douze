import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

/**
 * The relay ships as one file. It is the only package that runs on a machine that is not the
 * user's, so a deploy is `scp dist/index.js` and nothing else — no install step, no
 * `node_modules` tree to keep in sync with the host's Node.
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

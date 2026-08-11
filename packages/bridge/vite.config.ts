import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

/**
 * One file with a shebang, because this is what `npx @douze/bridge` fetches: a developer running
 * it should not pay for an install tree, and an MCP client spawning it should not depend on one
 * resolving correctly from wherever it set its cwd.
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
      output: {
        format: 'es',
        entryFileNames: 'index.js',
        chunkFileNames: '[name].js',
        banner: '#!/usr/bin/env node',
      },
    },
  },
  ssr: { noExternal: true },
})

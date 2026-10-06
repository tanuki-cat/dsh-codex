import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/codex.ts', 'src/management.ts'],
    platform: 'node',
    format: 'esm',
    unbundle: true,
    outDir: 'lib',
    fixedExtension: false,
    dts: true,
  },
  {
    entry: ['src/client.ts'],
    platform: 'browser',
    format: 'iife',
    deps: { neverBundle: ['react'] },
    outDir: 'lib',
    clean: false,
    fixedExtension: false,
    outputOptions: { entryFileNames: 'client.js' },
  },
])

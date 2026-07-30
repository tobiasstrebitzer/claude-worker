import { defineConfig } from 'tsdown'

export default defineConfig({
  // Two entries: the library surface (`startInstance`, for hosts that want the
  // turnkey wiring inside their own process) and the `bin`.
  entry: ['./src/index.ts', './src/cli.ts'],
  outDir: 'build',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: [/^[^./]/] },
})

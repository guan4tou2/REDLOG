import { defineConfig } from 'vitest/config'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'

const pkgVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    pool: 'forks',
    // Vitest 4 removed `poolOptions` and moved these to the top level, so the
    // `minForks: 2, maxForks: 4` that used to live here has been silently
    // ignored since the upgrade — vitest says so on every run:
    //
    //   DEPRECATED  `test.poolOptions` was removed in Vitest 4. All previous
    //   `poolOptions` are now top-level options.
    //
    // The effect was not cosmetic. With no cap, a run spawns one worker per
    // file — `Isolate 182 workers spawned · ~1.06s startup each` — and that
    // load is what tips timing-sensitive assertions over. Two of the flakes
    // chased down recently were exactly that shape: `tailer-seed` compared
    // wall-clock ratios, and `shell-redlog-run` spawns a real bash and blew
    // the 5s default. Restoring the intended cap restores the intended
    // concurrency.
    minWorkers: 2,
    maxWorkers: 4,
    // The default 5s is tight for the suite's process-spawning tests on a
    // loaded Windows box, and a timeout there reads as a failure of whatever
    // the test asserts rather than of the clock. A genuine hang still ends the
    // run; a busy machine no longer fails a passing test.
    testTimeout: 15_000,
  },
})

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
    // `hookTimeout` is a separate budget and was left at its 10s default when
    // testTimeout was raised. Hooks here do real work — a beforeEach that
    // mkdtemps a directory, opens a SQLite database and seeds it — and on a
    // loaded Windows runner that is what tips over first:
    //
    //   FAIL test/timeline-filter-completeness.test.ts
    //   Error: Hook timed out in 10000ms.
    //     at beforeEach → fs.mkdtempSync(...); db.initDB(dir)
    //
    // In the same run `chain-concurrency` took 46.8s, so the box was busy, not
    // the hook slow. Same reasoning as testTimeout: a genuine hang still ends
    // the run, a busy machine no longer fails a passing test.
    hookTimeout: 15_000,
    // Keep a machine-readable record of every run in CI.
    //
    // The suite has an intermittent failure that lands on a different file
    // each time — `mark-assets`, `chain-sampling`, `project-manager`,
    // `confirm-dialog` so far, roughly one run in ten, each passing in
    // isolation. Diagnosing it locally means reproducing it, and twelve
    // consecutive clean runs is what that attempt looked like.
    //
    // CI runs the suite far more often than anyone runs it by hand, so the
    // cheaper place to catch it is there — but only if the run keeps the
    // failure message and stack instead of the summary line. JUnit XML carries
    // both, and the workflow uploads it on failure. Local runs are untouched:
    // the default reporter still prints, and the file is only written when CI
    // is set.
    reporters: process.env.CI
      ? ['default', ['junit', { outputFile: 'test-results/unit-junit.xml' }]]
      : ['default'],
  },
})

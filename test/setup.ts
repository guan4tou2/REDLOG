import fs from 'fs'
import path from 'path'
import os from 'os'
import { createRequire } from 'module'
import { afterAll, expect } from 'vitest'
import { installStallTiming } from './helpers/stall-timing'
import { installIcaclsRecorder } from './helpers/icacls'

// restrictToOwner records its icacls arguments instead of spawning icacls; why,
// and which files put the real one back, is in test/helpers/icacls.ts.
installIcaclsRecorder()

// v0.6.89: isolate signing keypair storage from the operator's real
// ~/.redlog/keys directory. Every test session gets a fresh tmpdir so
// createOperator (which mints an Ed25519 key on the fly) can't leak state
// across runs, and CI environments without a writable $HOME still function.
const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-vitest-keys-'))
process.env.REDLOG_KEYS_DIR = keysDir

// hooks-manager asks zsh where it reads `.zshrc` (`zsh -c`, which runs
// `${ZDOTDIR:-$HOME}/.zshenv`). Many tests reach it through detectHooks()
// without moving HOME, and a test must never run the developer's own
// `~/.zshenv`. An empty ZDOTDIR per file makes every zsh a test starts read
// nothing of the operator's. A test about ZDOTDIR itself deletes this first.
process.env.ZDOTDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-vitest-zdotdir-'))

// The project writer sets `synchronous = FULL` (spec 071), which flushes the
// disk on every commit; a derived index in WAL flushes at every checkpoint.
// On a Windows runner one flush costs about 100 ms: read against the flush
// counts taken with a native fsync counter, the three slowest files fit that
// figure (404 flushes, 37-50 s; 579, 50-68 s; about 15, 1.2 s), and a slow
// spell on the runner took a 200-row loop past the 15 s timeout. Lowering
// the writer to NORMAL removed the per-commit flush and left the checkpoint
// ones, so the suite runs every connection at OFF: SQLite hands the pages to
// the operating system and never waits for the disk. Nothing in the suite
// pulls the power, so no test can tell the difference, and a killed process
// loses nothing the operating system already holds.
//
// Two places set it. An explicit `synchronous = FULL` is rewritten before it
// reaches SQLite. The derived indexes (http-body-index, cast-index) never set
// `synchronous` at all and run at the WAL default, NORMAL, which still
// flushes at checkpoints; a rewrite has nothing to catch there, so OFF is
// also set right after `journal_mode = WAL`.
// Production is untouched; `test/hash-input-pin.test.ts` is the place that
// checks the real setting (it sets REDLOG_TEST_REAL_SYNCHRONOUS=1).
// If the native module cannot load here, do nothing: the files that need it
// report that through test/helpers/requires.ts, and this setup also runs for
// the jsdom component tests.
try {
  const Database = createRequire(import.meta.url)('better-sqlite3')
  const marker = Symbol.for('redlog.test.synchronousRelaxed')
  const proto = Database.prototype
  if (!proto[marker]) {
    const realPragma = proto.pragma
    proto.pragma = function (this: unknown, ...args: unknown[]) {
      if (
        typeof args[0] === 'string' &&
        process.env.REDLOG_TEST_REAL_SYNCHRONOUS !== '1' &&
        /^\s*synchronous\s*=\s*FULL\s*$/i.test(args[0])
      ) {
        args[0] = 'synchronous = OFF'
      }
      const toWal =
        typeof args[0] === 'string' &&
        process.env.REDLOG_TEST_REAL_SYNCHRONOUS !== '1' &&
        /^\s*journal_mode\s*=\s*WAL\s*$/i.test(args[0])
      // Before the switch as well as after: the switch itself commits through
      // the rollback journal at whatever `synchronous` the connection has, and
      // a new connection has FULL. On the Windows runner that one pragma was
      // 30 of the 47 calls over 250 ms in a run, up to 2.5 s each.
      if (toWal) realPragma.call(this, 'synchronous = OFF')
      const result = realPragma.apply(this, args)
      if (toWal) realPragma.call(this, 'synchronous = OFF')
      return result
    }
    Object.defineProperty(proto, marker, { value: true })
  }
  // The helper's injected flag lets tests exercise this gate on other OSes.
  const enabled = process.platform === 'win32' && !!process.env.CI
  const timing = installStallTiming({
    enabled,
    fs,
    Database,
    get statementPrototype() {
      const probe = new Database(':memory:')
      try { return Object.getPrototypeOf(probe.prepare('SELECT 1')) } finally { probe.close() }
    },
    replaceDatabase: replacement => {
      const require = createRequire(import.meta.url)
      require.cache[require.resolve('better-sqlite3')]!.exports = replacement
    },
    syncBuiltinESMExports: createRequire(import.meta.url)('module').syncBuiltinESMExports,
  })
  afterAll(() => {
    timing.summary(expect.getState().testPath ?? '<unknown test file>')
    timing.restore()
  })
} catch {
  // The SQLite binding could not be loaded; requires() reports availability.
}

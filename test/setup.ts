import fs from 'fs'
import path from 'path'
import os from 'os'
import { createRequire } from 'module'

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
// disk on every commit. On Windows that is a real flush, and tests that seed
// rows one autocommit at a time went from about 1-5 s to 3-17 s per file on
// green runs and past the 15 s timeout on slow runners. The suite runs the
// writer at NORMAL instead, by rewriting that one pragma before it reaches
// SQLite. Production is untouched; `test/hash-input-pin.test.ts` is the
// place that checks the real setting (it sets REDLOG_TEST_REAL_SYNCHRONOUS=1).
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
        args[0] = 'synchronous = NORMAL'
      }
      return realPragma.apply(this, args)
    }
    Object.defineProperty(proto, marker, { value: true })
  }
} catch {
  // better-sqlite3 is not built for this Node ABI; nothing to relax.
}

import fs from 'fs'
import path from 'path'
import os from 'os'

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

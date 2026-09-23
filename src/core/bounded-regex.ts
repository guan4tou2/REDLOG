// Run declared regex rules with a time bound (Spec 033).
//
// JavaScript cannot interrupt a regex that is running, and a catastrophically
// backtracking pattern — `(a+)+$` against a long run of `a` — runs for minutes.
// Loot rules run on the ingest path in the main process, so one such plugin
// rule froze capture and the UI with it. Here the rules run in a worker thread.
// The caller stays synchronous: it posts the job, blocks on an Atomics word
// with a timeout, and reads the reply with receiveMessageOnPort. On timeout the
// worker is terminated, and the rule it was on is reported so the caller can
// stop it; a fresh worker starts on the next call.

import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from 'worker_threads'

export interface BoundedRule {
  source: string
  flags: string
  /** 0 = whole match, n = capture group n. */
  group: number
}

export interface BoundedMatch { value: string; index: number }

export type BoundedResult =
  | { ok: true; matches: BoundedMatch[][] }
  /** `stuckAt` is the index of the rule that was running when time ran out. */
  | { ok: false; stuckAt: number }

// Word 0: done flag (0 running, 1 done). Word 1: index of the rule in progress.
// Word 2: ready flag, set once the worker is listening — startup is not
// counted against a job's time bound.
const WORKER_SOURCE = `
const { workerData, parentPort } = require('worker_threads')
const { port, sab } = workerData
const words = new Int32Array(sab)
Atomics.store(words, 2, 1)
Atomics.notify(words, 2)
parentPort.on('message', ({ rules, text }) => {
  const out = []
  for (let i = 0; i < rules.length; i++) {
    Atomics.store(words, 1, i)
    const { source, flags, group } = rules[i]
    const re = new RegExp(source, flags.includes('g') ? flags : flags + 'g')
    const found = []
    let m
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      const value = m[group]
      if (value) found.push({ value, index: m.index })
    }
    out.push(found)
  }
  port.postMessage(out)
  Atomics.store(words, 0, 1)
  Atomics.notify(words, 0)
})
`

let live: { worker: Worker; port: MessagePort; words: Int32Array } | null = null

function start(): NonNullable<typeof live> {
  if (live) return live
  const sab = new SharedArrayBuffer(12)
  const { port1, port2 } = new MessageChannel()
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { port: port2, sab }, transferList: [port2] })
  // An idle rule worker must not keep the app (or a test run) alive.
  worker.unref()
  port1.unref()
  const words = new Int32Array(sab)
  // A cold worker on a loaded machine can take far longer to start than any
  // rule takes to run; wait for it here so startup never reads as a timeout.
  Atomics.wait(words, 2, 0, 5000)
  live = { worker, port: port1, words }
  return live
}

export function runBounded(rules: BoundedRule[], text: string, timeoutMs: number): BoundedResult {
  if (rules.length === 0) return { ok: true, matches: [] }
  const w = start()
  Atomics.store(w.words, 0, 0)
  Atomics.store(w.words, 1, 0)
  w.worker.postMessage({ rules, text })
  if (Atomics.wait(w.words, 0, 0, timeoutMs) === 'timed-out') {
    const stuckAt = Atomics.load(w.words, 1)
    void w.worker.terminate()
    live = null
    return { ok: false, stuckAt }
  }
  const reply = receiveMessageOnPort(w.port)
  return { ok: true, matches: (reply?.message as BoundedMatch[][] | undefined) ?? rules.map(() => []) }
}

/** Tests: stop the worker so the run can exit cleanly. */
export async function _shutdownBoundedRegex(): Promise<void> {
  const w = live
  live = null
  if (w) await w.worker.terminate()
}

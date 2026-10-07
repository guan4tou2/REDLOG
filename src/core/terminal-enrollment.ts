// Whether a terminal is recording, in what mode, and for which project.
// Spec 052, research.md D4/D5.
//
// The state cannot live in shell variables. A subshell loses them, the next
// prompt is a new `preexec` that remembers nothing, and RedLog itself has to
// be able to read the answer to put it on the capture card. So it is a file
// per terminal under `~/.redlog/terminals/`, written by whichever side
// changed it and read by both — one source for `redlog status` and for the
// card (Principle II).
//
// Two of these rules are the whole reason an operator would leave the feature
// on:
//
//   FR-022  a stop stays stopped. Not for this prompt — until it is started
//           again. Anything less and `redlog stop` before a client credential
//           is a suggestion.
//   FR-010  a terminal is pinned to the project it was opened against. On a
//           switch it stops and says so; it never writes into the new one,
//           and it cannot be talked back into recording, because the safe
//           answer is a new terminal.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyCommand, type CommandClass } from './terminal-class'

export type TerminalMode = 'auto' | 'manual'
export type TerminalStopReason = 'operator' | 'project-switched'

export interface TerminalEnrollment {
  sessionId: string
  mode: TerminalMode
  recording: boolean
  stoppedReason?: TerminalStopReason
  /** Pinned at terminal start and never updated — see FR-010. */
  engagementId: string
  operatorId: string
  startedAt: number
}

export interface CaptureDecision {
  /** Whether this command's OUTPUT is held. The command itself is recorded
   *  either way when the terminal is recording; `false` here means the event
   *  carries `not-captured` rather than going missing. */
  capture: boolean
  class: CommandClass
  reason: 'recording' | 'stopped' | 'project-switched' | 'class-native'
}

export function beginTerminal(opts: {
  sessionId: string
  mode: TerminalMode
  engagementId: string
  operatorId: string
  now?: number
}): TerminalEnrollment {
  return {
    sessionId: opts.sessionId,
    mode: opts.mode,
    recording: opts.mode === 'auto',
    engagementId: opts.engagementId,
    operatorId: opts.operatorId,
    startedAt: opts.now ?? Date.now()
  }
}

export type TerminalAction =
  /** FR-021, at runtime and without reinstalling. */
  | { type: 'mode'; mode: TerminalMode }
  | { type: 'stop'; reason: TerminalStopReason }
  | { type: 'start' }
  /** FR-010, with whatever project RedLog has open now. */
  | { type: 'project'; engagementId: string }

/** Every transition, in one place, because the rules only make sense beside
 *  each other: a project switch outranks a start, and a mode change must not
 *  re-bind a terminal to a project it was not opened against. */
export function applyTerminalAction(state: TerminalEnrollment, action: TerminalAction): TerminalEnrollment {
  // A terminal whose project moved out from under it stays stopped, whatever
  // it is asked. Letting `redlog start` or `redlog mode auto` undo that would
  // make the pin one keystroke deep, and the failure it prevents — a command
  // from engagement A filed under B — is a lie in a document a client reads.
  const pinBroken = state.stoppedReason === 'project-switched'

  switch (action.type) {
    case 'mode':
      if (pinBroken) return { ...state, mode: action.mode }
      return action.mode === 'auto'
        ? { ...state, mode: action.mode, recording: true, stoppedReason: undefined }
        : { ...state, mode: action.mode, recording: false, stoppedReason: 'operator' }
    case 'stop':
      return { ...state, recording: false, stoppedReason: action.reason }
    case 'start':
      if (pinBroken) return state
      return { ...state, recording: true, stoppedReason: undefined }
    case 'project':
      if (action.engagementId === state.engagementId) return state
      return { ...state, recording: false, stoppedReason: 'project-switched' }
  }
}

export function captureDecision(state: TerminalEnrollment, argv: string[]): CaptureDecision {
  const commandClass = classifyCommand(argv)
  if (!state.recording) {
    return {
      capture: false,
      class: commandClass,
      reason: state.stoppedReason === 'project-switched' ? 'project-switched' : 'stopped'
    }
  }
  // `native` means the output is never held — an editor's redraws are not
  // evidence, and `nc` must stay suspendable (FR-025/FR-026).
  if (commandClass === 'native') return { capture: false, class: commandClass, reason: 'class-native' }
  return { capture: true, class: commandClass, reason: 'recording' }
}

// ── The file, which is the memory ───────────────────────────────────────────

export function terminalStateDir(home: string = os.homedir()): string {
  return path.join(home, '.redlog', 'terminals')
}

function statePath(home: string, sessionId: string): string {
  // A session id reaches us from a shell. It names a file, so it is reduced
  // to something that cannot leave the directory it is written in.
  return path.join(terminalStateDir(home), `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

export function writeTerminalEnrollment(home: string, state: TerminalEnrollment): void {
  const dir = terminalStateDir(home)
  fs.mkdirSync(dir, { recursive: true })
  const target = statePath(home, state.sessionId)
  const tmp = `${target}.part`
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
  // Whole or not at all: the reader is a prompt hook that cannot wait, and a
  // half-written file reads as a terminal that is not recording.
  fs.renameSync(tmp, target)
}

export function readTerminalEnrollment(home: string, sessionId: string): TerminalEnrollment | null {
  return parse(statePath(home, sessionId))
}

/** A terminal that has exited is not a terminal that stopped recording — it
 *  is gone, and leaving its file behind would have the card counting it. */
export function removeTerminalEnrollment(home: string, sessionId: string): void {
  try {
    fs.rmSync(statePath(home, sessionId), { force: true })
  } catch {
    /* a file we cannot remove is one stale row, not a reason to fail a close */
  }
}

export function listTerminalEnrollments(home: string): TerminalEnrollment[] {
  const dir = terminalStateDir(home)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: TerminalEnrollment[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const state = parse(path.join(dir, name))
    if (state) out.push(state)
  }
  return out
}

function parse(file: string): TerminalEnrollment | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const value = JSON.parse(text) as Partial<TerminalEnrollment>
    if (typeof value.sessionId !== 'string' || typeof value.engagementId !== 'string') return null
    return {
      sessionId: value.sessionId,
      mode: value.mode === 'manual' ? 'manual' : 'auto',
      recording: value.recording === true,
      stoppedReason: value.stoppedReason,
      engagementId: value.engagementId,
      operatorId: typeof value.operatorId === 'string' ? value.operatorId : '',
      startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0
    }
  } catch {
    // A file we cannot read is one terminal we cannot report on, not a reason
    // to report nothing about the others.
    return null
  }
}

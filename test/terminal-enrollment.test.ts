import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  beginTerminal, applyTerminalAction, captureDecision,
  readTerminalEnrollment, writeTerminalEnrollment, removeTerminalEnrollment,
  listTerminalEnrollments, terminalStateDir
} from '../src/core/terminal-enrollment'

// Spec 052 T016. Two properties decide whether an operator will leave this
// turned on, and both are about trust rather than capture:
//
//   FR-022 — a stop has to stay stopped. A stop that a shell variable holds
//            is gone at the next subshell, and an operator who types `redlog
//            stop` before a client's credential and sees it recorded anyway
//            uninstalls the tool and the engagement goes unrecorded.
//   FR-010 — a terminal records the project it was opened against, and when
//            the operator switches project under it, it stops. It never
//            writes into the new one. Spec 022 already pins identity at
//            launch; this must not weaken that.

const tempDirs: string[] = []
afterEach(() => { for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const home = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-enroll-'))
  tempDirs.push(dir)
  return dir
}

const open = (overrides: Partial<Parameters<typeof beginTerminal>[0]> = {}) =>
  beginTerminal({
    sessionId: 'term-1', mode: 'auto',
    engagementId: 'eng-1', operatorId: 'op-1',
    now: 1_700_000_000_000,
    ...overrides
  })

describe('terminal enrollment', () => {
  it('records from the first prompt in auto, and not at all in manual', () => {
    expect(open().recording).toBe(true)
    expect(open({ mode: 'manual' }).recording).toBe(false)
  })

  it('switches mode at runtime without losing the pinned identity', () => {
    // FR-021. Changing mode must not mean reinstalling, and must not mean a
    // terminal quietly re-binding itself to whatever project is open now.
    const manual = applyTerminalAction(open(), { type: 'mode', mode: 'manual' })
    expect(manual.mode).toBe('manual')
    expect(manual.recording).toBe(false)

    const auto = applyTerminalAction(manual, { type: 'mode', mode: 'auto' })
    expect(auto.recording).toBe(true)
    expect(auto.engagementId).toBe('eng-1')
    expect(auto.operatorId).toBe('op-1')
  })

  it('keeps a stop across a process that knows nothing about the one that stopped it', () => {
    // FR-022, the durable stop. The next prompt is a new `preexec` in a shell
    // that has kept no memory of the last one — the file is the memory.
    const dir = home()
    writeTerminalEnrollment(dir, applyTerminalAction(open(), { type: 'stop', reason: 'operator' }))

    const reread = readTerminalEnrollment(dir, 'term-1')!
    expect(reread.recording).toBe(false)
    expect(reread.stoppedReason).toBe('operator')
    expect(captureDecision(reread, ['nmap', '-sV', '10.0.0.1']).capture).toBe(false)

    const resumed = applyTerminalAction(reread, { type: 'start' })
    expect(resumed.recording).toBe(true)
    expect(resumed.stoppedReason).toBeUndefined()
  })

  it('stops rather than re-attributes when the project changes under it', () => {
    // FR-010. The dangerous outcome is not a missing command; it is a command
    // from engagement A filed under engagement B, which is a lie in a document
    // a client reads.
    const switched = applyTerminalAction(open(), { type: 'project', engagementId: 'eng-2' })

    expect(switched.recording).toBe(false)
    expect(switched.stoppedReason).toBe('project-switched')
    expect(switched.engagementId, 'the pin must not follow the switch').toBe('eng-1')
    expect(captureDecision(switched, ['whoami']).reason).toBe('project-switched')
  })

  it('will not let a project-switched terminal be talked back into recording', () => {
    // The safe default is a new terminal (research.md D5). `redlog start` in
    // the old one must not be the way around that, or the guarantee above is
    // one keystroke deep.
    const switched = applyTerminalAction(open(), { type: 'project', engagementId: 'eng-2' })

    expect(applyTerminalAction(switched, { type: 'start' }).recording).toBe(false)
    // …and not through the mode switch either, which is the same door.
    const forced = applyTerminalAction(switched, { type: 'mode', mode: 'auto' })
    expect(forced.recording).toBe(false)
    expect(forced.stoppedReason).toBe('project-switched')
  })

  it('leaves an unchanged project alone', () => {
    const same = applyTerminalAction(open(), { type: 'project', engagementId: 'eng-1' })
    expect(same.recording).toBe(true)
    expect(same.stoppedReason).toBeUndefined()
  })

  it('asks the classifier what to do with each command, and says why', () => {
    const live = open()
    expect(captureDecision(live, ['nmap', '-sV', '10.0.0.1'])).toMatchObject({
      capture: true, class: 'relayed', reason: 'recording'
    })
    // A native command is still a recorded command — it is the OUTPUT that is
    // not held, and the event says so rather than going missing (FR-025).
    expect(captureDecision(live, ['sudo', 'nc', '-lvnp', '4444'])).toMatchObject({
      capture: false, class: 'native', reason: 'class-native'
    })
  })

  it('reads back every terminal it wrote, and ignores what it did not', () => {
    const dir = home()
    writeTerminalEnrollment(dir, open())
    writeTerminalEnrollment(dir, open({ sessionId: 'term-2', mode: 'manual' }))
    fs.writeFileSync(path.join(terminalStateDir(dir), 'not-json.json'), '{oops')

    const all = listTerminalEnrollments(dir)
    expect(all.map((t) => t.sessionId).sort()).toEqual(['term-1', 'term-2'])
    expect(all.filter((t) => t.recording)).toHaveLength(1)

    // A terminal that exited is gone, not stopped. Left behind, the card
    // counts a pane that closed yesterday as capture this machine has.
    removeTerminalEnrollment(dir, 'term-1')
    expect(listTerminalEnrollments(dir).map((t) => t.sessionId)).toEqual(['term-2'])
    // Removing one that is already gone is not an error — a close can race a
    // close, and failing here would fail the pane's teardown.
    removeTerminalEnrollment(dir, 'term-1')
  })

  it('returns null for a terminal it has never seen', () => {
    expect(readTerminalEnrollment(home(), 'never')).toBeNull()
    expect(listTerminalEnrollments(path.join(os.tmpdir(), 'redlog-no-such-home'))).toEqual([])
  })
})

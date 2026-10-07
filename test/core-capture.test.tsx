// @vitest-environment jsdom
//
// #217: Commands and HTTP(S) are both core capture. Each is verified by an
// event that actually arrived, neither waits on the other, and once the
// operator leaves first-run the Dashboard keeps naming both — so HTTP(S) left
// unset does not fold out of sight the moment a command starts recording.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import { commandsVerification, coreCaptureReady, isCommandEvent } from '../src/renderer/src/lib/coreCapture'

const shell = (subtype: string, source?: string): { agentType: string; data: Record<string, unknown> } =>
  ({ agentType: 'shell', data: { subtype, command: 'id', ...(source ? { source } : {}) } })
const http = { agentType: 'scanner', data: { subtype: 'http_request_start' } }

describe('core capture verification', () => {
  it('counts commands, not session bookkeeping or other capture', () => {
    expect(isCommandEvent(shell('command_start'))).toBe(true)
    expect(isCommandEvent(shell('command'))).toBe(true)
    expect(isCommandEvent(shell('command_end'))).toBe(true)
    expect(isCommandEvent(shell('session_start'))).toBe(false)
    expect(isCommandEvent(http)).toBe(false)
  })

  it('says which command path has delivered', () => {
    expect(commandsVerification([])).toBe('none')
    expect(commandsVerification([http, shell('session_start')])).toBe('none')
    expect(commandsVerification([shell('command_end', 'builtin-terminal')])).toBe('builtin')
    expect(commandsVerification([shell('command_end', 'builtin-terminal'), shell('command_end')])).toBe('external')
  })

  it('is ready only with both, and the built-in terminal alone counts for Commands', () => {
    expect(coreCaptureReady({ commands: 'none', http: true })).toBe(false)
    expect(coreCaptureReady({ commands: 'builtin', http: false })).toBe(false)
    expect(coreCaptureReady({ commands: 'builtin', http: true })).toBe(true)
    expect(coreCaptureReady({ commands: 'external', http: true })).toBe(true)
  })
})

function draw(sources: Record<string, unknown>[], managedHttpProxy?: Record<string, unknown>): HTMLElement {
  const capture = { verdict: 'partial', recording: true, sources, lastEventAt: null, checkedAt: 1, ...(managedHttpProxy ? { managedHttpProxy } : {}) }
  const { container } = render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={() => {}} />
    </I18nProvider>
  )
  return container
}

// One terminal row, fed by RedLog's own panes and by the operator's own shell.
const terminal = { id: 'terminal', state: 'ready', lastEventAt: Date.now() }
const mitm = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: 'mitmproxy', hookId: 'mitmproxy', installed: true, state: 'ready', lastEventAt: null, ...over })

describe('the Dashboard keeps both core captures in view', () => {
  beforeEach(() => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  it('flags HTTP(S) as not started while commands are recording', () => {
    const el = draw([terminal, mitm()], { state: 'stopped', url: null })
    const cmd = el.querySelector('[data-testid="capture-core-commands"]')
    const web = el.querySelector('[data-testid="capture-core-http"]')
    expect(cmd?.getAttribute('data-state')).toBe('ready')
    expect(web?.getAttribute('data-state')).toBe('stopped')
    expect(web?.textContent).toMatch(/not started/i)
  })

  it('shows both as capturing once both are', () => {
    const el = draw([terminal, mitm({ state: 'ready', lastEventAt: Date.now() })], { state: 'running', url: null })
    expect(el.querySelector('[data-testid="capture-core-http"]')?.getAttribute('data-state')).toBe('ready')
    expect(el.querySelector('[data-testid="capture-core-commands"]')?.getAttribute('data-state')).toBe('ready')
  })

  it('says HTTP(S) once: no mitmproxy problem row under the core line', () => {
    // The screenshot that prompted this: 未安裝 mitmproxy on the core line and
    // again on a mitmproxy row directly beneath it, from the same state.
    const el = draw([terminal, mitm()], { state: 'unavailable', url: null, error: 'spawn mitmdump ENOENT' })
    expect(el.querySelector('[data-testid="capture-core-http"]')?.textContent).toMatch(/not installed/)
    expect(el.querySelector('[data-testid="capture-row-mitmproxy"]')).toBeNull()
    // …and the empty exception list does not then claim all is well.
    expect(el.textContent).not.toMatch(/All good/)
  })

  it('moves the row detail onto the core line', () => {
    const failed = draw([terminal, mitm()], { state: 'failed', url: null, error: '127.0.0.1:6661 is already in use by BurpSuite.exe' })
    expect(failed.querySelector('[data-testid="capture-core-http"]')?.textContent).toMatch(/already in use by BurpSuite\.exe/)
    expect(failed.textContent?.match(/already in use/g)).toHaveLength(1)
  })

  it('still lists mitmproxy in the full inventory, without repeating the detail', () => {
    const el = draw([terminal, mitm()], { state: 'running', url: null })
    fireEvent.click(within(el).getByText(/all sources/))
    expect(el.querySelector('[data-testid="capture-row-mitmproxy"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="capture-state-mitmproxy"]')?.textContent).toMatch(/capturing/)
  })

  it('keeps a rogue mitmproxy row, which the core line cannot express', () => {
    const el = draw([terminal, mitm({ disabled: true, state: 'ready', lastEventAt: Date.now() })], { state: 'stopped', url: null })
    expect(el.querySelector('[data-testid="capture-rogue-mitmproxy"]')).toBeTruthy()
  })

  it('flags Commands when only HTTP(S) is recording', () => {
    const el = draw([{ id: 'terminal', state: 'unset', lastEventAt: null }, mitm({ state: 'ready', lastEventAt: Date.now() })], { state: 'running', url: null })
    expect(el.querySelector('[data-testid="capture-core-commands"]')?.getAttribute('data-state')).toBe('unset')
  })

  // A working source says so with one green light, and nothing else. The line
  // used to carry a word too — 記錄中 beside a green dot — which is one thing
  // said twice and leaves the reader checking that the two agree. The word is
  // kept for the cases a colour cannot carry: what is missing, and what to do.
  it('says a working terminal with a light, not a word, and dates it', () => {
    const quiet = { id: 'terminal', state: 'ready', lastEventAt: Date.now() - 29 * 60_000 }
    const el = draw([quiet, mitm({ state: 'ready', lastEventAt: Date.now() })], { state: 'running', url: null })
    const cmd = el.querySelector('[data-testid="capture-core-commands"]')
    expect(cmd?.getAttribute('data-state')).toBe('ready')
    expect(cmd?.textContent).not.toMatch(/recording|ready/i)
    // A quiet half-hour is reported as a date, not as a state: the operator
    // has not typed, which is not a fact about capture.
    expect(cmd?.querySelector('[data-testid="capture-core-commands-age"]')?.textContent).toMatch(/29m/)
  })

  it('speaks up only when a core capture cannot record', () => {
    const el = draw([{ id: 'terminal', state: 'unset', lastEventAt: null }, mitm({ state: 'ready', lastEventAt: Date.now() })], { state: 'running', url: null })
    const cmd = el.querySelector('[data-testid="capture-core-commands"]')
    expect(cmd?.textContent).toMatch(/not set up/i)
    // Nothing has been recorded, so there is no age to print — an empty
    // column, not a "—" pretending to be a reading.
    expect(cmd?.querySelector('[data-testid="capture-core-commands-age"]')?.textContent).toBe('')
  })
})

// A source with no hook to install and no switch to flip records when the
// operator uses the thing it watches, and does nothing when they do not.
// `idle` is its resting state. Under the old rule one event, ever, pinned such
// a source to the exception list for the rest of the engagement — with no
// control on the row to act on, under a heading that claims everything listed
// is wrong.
describe('the exception list does not nag about a passive source', () => {
  beforeEach(() => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  it('still shows a passive source that failed — that one carries a reason', () => {
    const broken = {
      id: 'screenshot', state: 'error', lastEventAt: null,
      lastError: { at: Date.now(), message: 'screen capture came back empty' }
    }
    const el = draw([broken, mitm({ state: 'ready', lastEventAt: Date.now() })], { state: 'running', url: null })
    expect(el.querySelector('[data-testid="capture-row-screenshot"]')).toBeTruthy()
    expect(el.textContent).toMatch(/came back empty/)
  })
})

// RedLog's own terminal is the terminal capability, not a competitor to the
// shell hook: nothing to install, nothing to switch, and which terminal a
// command came from is on the command, not on a capture row.
describe('the two terminals are one row', () => {
  beforeEach(() => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  it('names no RedLog terminal of its own, anywhere on the card', () => {
    const el = draw([terminal, mitm({ state: 'ready', lastEventAt: Date.now() })], { state: 'running', url: null })
    fireEvent.click(within(el).getByText(/all sources/))
    expect(el.querySelector('[data-testid="capture-row-builtin-terminal"]')).toBeNull()
    expect(el.textContent).not.toMatch(/RedLog terminal/)
    expect(el.querySelector('[data-testid="capture-row-terminal"]')).toBeTruthy()
  })

  it('says whether the operator\'s own terminal is in the record — in three states, not two', () => {
    // The only open question on the row: RedLog's panes always record, so
    // what is left to act on is whether the operator's own shell is included.
    //
    // Spec 052 FR-015 split the "yes" in half. A copied file and an appended
    // rc line prove that a setup flow ran, not that anything is being
    // captured — the rc has to be re-read, the adapter has to load, and the
    // transport has to reach RedLog. Until a command arrives from a terminal
    // that is not one of RedLog's panes, the card says setup is unfinished
    // rather than reporting on itself.
    const without = draw([{ ...terminal, hookId: 'shell-powershell', installed: false }], { state: 'stopped', url: null })
    fireEvent.click(within(without).getByText(/all sources/))
    expect(without.textContent).toMatch(/Your own terminal is not in the record/)
    cleanup()

    const installedOnly = draw(
      [{ ...terminal, hookId: 'shell-powershell', installed: true, ownShellLastEventAt: null }],
      { state: 'stopped', url: null })
    fireEvent.click(within(installedOnly).getByText(/all sources/))
    expect(installedOnly.textContent).toMatch(/open a new terminal and run a command/)
    expect(installedOnly.textContent).not.toMatch(/Your own terminal is included/)
    cleanup()

    const proven = draw(
      [{ ...terminal, hookId: 'shell-powershell', installed: true, ownShellLastEventAt: Date.now() }],
      { state: 'stopped', url: null })
    fireEvent.click(within(proven).getByText(/all sources/))
    expect(proven.textContent).toMatch(/Your own terminal is included/)
  })

  // FR-014. The install was deliberately not the card's action, because
  // RedLog's own pane records with nothing installed — it sat behind a
  // "manage sources" click as a second-order concern. Spec 052 changed what
  // the install buys: the hook is what brings the operator's OWN terminals
  // in, with their output. An operator working in their own shell would
  // otherwise read "healthy" on a machine whose real work is unrecorded.
  it('makes the install the one action once there is a record at all', () => {
    const el = draw(
      [{ ...terminal, lastEventAt: Date.now(), hookId: 'shell-powershell', installed: false }],
      { state: 'running', url: 'http://127.0.0.1:8080' })
    expect(el.textContent).toMatch(/Install the shell hook/)
  })

  it('offers it no more once the hook is in', () => {
    const el = draw(
      [{ ...terminal, lastEventAt: Date.now(), hookId: 'shell-powershell', installed: true, ownShellLastEventAt: Date.now() }],
      { state: 'running', url: 'http://127.0.0.1:8080' })
    expect(el.textContent).not.toMatch(/Install the shell hook/)
  })

  // T028: "RedLog's panes only" and "this machine's terminals too" are
  // different situations, and the card could not tell them apart.
  it('counts the terminals that have enrolled', () => {
    const el = draw(
      [{ ...terminal, hookId: 'shell-powershell', installed: true, ownShellLastEventAt: Date.now(), enrolled: { total: 3, recording: 2 } }],
      { state: 'stopped', url: null })
    fireEvent.click(within(el).getByText(/all sources/))
    expect(el.textContent).toMatch(/2 of 3 recording/)
  })

  it('a terminal recording with no hook installed is not "not installed"', () => {
    // RedLog's own pane needs nothing installed, so `installed: false` on this
    // row says the operator's shell is not wired — never that terminal capture
    // is missing. The card must report the feed, not the probe.
    const el = draw([{ ...terminal, hookId: 'shell-powershell', installed: false }], { state: 'stopped', url: null })
    expect(el.querySelector('[data-testid="capture-core-commands"]')?.getAttribute('data-state')).toBe('ready')
    expect(el.textContent).not.toMatch(/No capture source/i)
    fireEvent.click(within(el).getByText(/all sources/))
    expect(el.querySelector('[data-testid="capture-state-terminal"]')?.textContent).toMatch(/ready/i)
  })
})

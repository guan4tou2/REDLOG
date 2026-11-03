// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, within, fireEvent, waitFor } from '@testing-library/react'
import HooksPanel from '../src/renderer/src/components/settings/HooksPanel'
import { compileClassPolicy, knownProfiles } from '../src/core/terminal-class'
import type { ToolDetectionSnapshot, EnvironmentDetection, ProfileDetection } from '../src/core/tool-detection'
import { formatDateTime } from '../src/renderer/src/lib/time'
import en from '../src/renderer/src/i18n/en.json'

// #499 PR C, slice 1: one card per tool profile, built from what the compiler
// and the detector already say. Four things are kept apart on purpose: the
// policy (what the class is, and where it came from), how that is actually
// captured, what it costs the operator, and whether the tool was found. "Found"
// is not "capturing" and "not found" is not "profile off", and the card must
// not let either read that way.
//
// The inputs are the real compiler's and the real profile registry's, so a
// change to either that this panel misreads fails here, not in a screenshot.

const strings = en as Record<string, string>
const t = (key: string, vars?: Record<string, string | number>): string =>
  (strings[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars?.[k] ?? `{{${k}}}`))

const plugin = (profiles: unknown[], held: Record<string, string> = {}): unknown => ({ version: 1, profiles, held })
const acme = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'acme/ssh2', name: 'Acme SSH', mode: 'native', executables: ['ssh'], reason: 'Acme says so.', ...over
})

const policyFor = (contributed: unknown = null, overlay: unknown = null) => ({
  mode: 'auto' as const,
  app: 'all',
  ...compileClassPolicy(overlay, undefined, contributed),
  profiles: knownProfiles(undefined, contributed)
})

const detection = (name: string, state: 'found' | 'missing' | 'unchecked', where?: string): ProfileDetection => ({
  profile: name, state,
  executables: [{ name, state, ...(where ? { path: where } : {}) }]
})
const env = (over: Partial<EnvironmentDetection> & Pick<EnvironmentDetection, 'id' | 'source'>): EnvironmentDetection => ({
  platform: 'linux', detectedAt: Date.UTC(2026, 10, 3, 9, 30), stale: false, profiles: [], ...over
})
const snapshot = (...environments: EnvironmentDetection[]): ToolDetectionSnapshot =>
  ({ environments, scanning: false, lastTrigger: 'settings-open' })

interface Bridge {
  policy?: unknown
  snap?: ToolDetectionSnapshot
}
function draw({ policy = policyFor(), snap = snapshot() }: Bridge = {}) {
  const rescan = vi.fn(async (_reason: string) => snap)
  const detect = vi.fn(async () => snap)
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'linux',
    hooks: {
      detect: async () => [],
      setTerminalApp: async (v: string) => v,
      terminalPolicy: async () => policy
    },
    tools: { detection: detect, rescan }
  }
  render(<HooksPanel hooks={[]} setHooks={() => {}} t={t} />)
  return { rescan, detect }
}

const card = async (name: string): Promise<HTMLElement> => {
  const found = await screen.findByRole('group', { name })
  return found
}

describe('a tool profile card', () => {
  afterEach(() => cleanup())

  it('reads a miss as not found on PATH, and leaves the mode it did not change in view', async () => {
    const ssh = snapshot(
      env({ id: 'app:linux', source: 'app', profiles: [detection('ssh', 'missing')] }),
      env({ id: 'shell:zsh', source: 'shell', shell: 'zsh', profiles: [detection('ssh', 'found', '/usr/bin/ssh')] })
    )
    draw({ snap: ssh })
    const c = within(await card('SSH'))
    const text = c.getByTestId('tool-card-detection-ssh').textContent ?? ''
    expect(text).toContain('Not found on PATH')
    expect(text).toContain('/usr/bin/ssh')
    // app and shell are two reports, named as two
    expect(text).toContain('RedLog app')
    expect(text).toContain('Shell zsh')
    expect(text).toContain(formatDateTime(Date.UTC(2026, 10, 3, 9, 30)))
    // the miss is about the PATH it looked in; the mode below is untouched by it
    expect(c.getByTestId('tool-card-mode-ssh').textContent).toContain('PTY')
    expect(c.getByTestId('tool-card-mode-ssh').textContent).toContain('This profile')
  })

  it('keeps the effective mode on a profile that is missing everywhere, and never calls it off', async () => {
    const none: ProfileDetection = { profile: 'vim', state: 'missing', executables: [{ name: 'vim', state: 'missing' }, { name: 'vi', state: 'missing' }] }
    draw({ snap: snapshot(env({ id: 'app:linux', source: 'app', profiles: [none] })) })
    const c = within(await card('Vim'))
    expect(c.getByTestId('tool-card-detection-vim').textContent).toContain('Not found on PATH')
    expect(c.getByTestId('tool-card-mode-vim').textContent).toContain('Native')
    expect(c.getByTestId('tool-card-mode-vim').textContent).toContain('vim')
    const whole = (await card('Vim')).textContent ?? ''
    expect(whole).not.toMatch(/\b(off|disabled|inactive|not enabled|unsupported)\b/i)
  })

  it('says not checked when no report covers the profile, and stale when a report is old', async () => {
    draw({ snap: snapshot(
      env({ id: 'app:linux', source: 'app', profiles: [] }),
      env({ id: 'shell:bash', source: 'shell', shell: 'bash', stale: true, profiles: [detection('ssh', 'found', '/usr/bin/ssh')] })
    ) })
    const c = within(await card('SSH'))
    const text = c.getByTestId('tool-card-detection-ssh').textContent ?? ''
    expect(text).toMatch(/RedLog app.*Not checked/)
    expect(text).toMatch(/Shell bash.*Stale/)
  })

  it('shows a conflict with its reason and the profile that kept the command, on both cards', async () => {
    // acme/ssh2 claims `ssh` as native; the SSH profile had it and keeps it.
    draw({ policy: policyFor(plugin([acme()], { ssh: 'ssh' })) })
    const ssh = within(await card('SSH'))
    const conflict = ssh.getByTestId('tool-card-conflict-ssh-ssh').textContent ?? ''
    expect(conflict).toContain('ssh is claimed by ssh (PTY), acme/ssh2 (Native)')
    expect(conflict).toContain('ssh kept it')
    expect(ssh.getByTestId('tool-card-mode-ssh').textContent).toContain('PTY')
    const other = within(await card('Acme SSH'))
    expect(other.getByTestId('tool-card-conflict-acme/ssh2-ssh').textContent).toContain('ssh kept it')
    // the loser's own card says the mode in effect is somebody else's
    expect(other.getByTestId('tool-card-mode-acme/ssh2').textContent).toMatch(/PTY.*Profile ssh/)
  })

  it('says so when no profile kept a contested command', async () => {
    draw({ policy: policyFor(plugin([acme()])) })
    const ssh = within(await card('SSH'))
    expect(ssh.getByTestId('tool-card-conflict-ssh-ssh').textContent).toContain('No profile kept it')
  })

  it('lists a profile that could not be used instead of dropping it silently', async () => {
    draw({ policy: policyFor(plugin([{ id: 'acme/bad', mode: 'sideways', executables: ['x'] }])) })
    await card('SSH')
    expect(screen.getByTestId('tool-profile-problems').textContent).toContain('Profile acme/bad is not usable and was skipped.')
  })

  it('tells a pty command in bash that it runs native, with the recorded reason, apart from the policy', async () => {
    draw()
    const ssh = within(await card('SSH'))
    const policy = ssh.getByTestId('tool-card-mode-ssh').textContent ?? ''
    const captured = ssh.getByTestId('tool-card-capture-ssh').textContent ?? ''
    expect(policy).toContain('PTY')
    expect(captured).toContain('bash')
    expect(captured).toContain('no PTY wrapper')
    expect(captured).toContain('capture_reason no-pty-wrapper')
    expect(captured).toContain('zsh')
    // classification and capture are different statements, and neither is "supported"
    expect(policy).not.toContain('no-pty-wrapper')
    expect((await card('SSH')).textContent).not.toMatch(/supported/i)
    expect(ssh.getByTestId('tool-card-limits-ssh').textContent).toContain('Ctrl-Z')
  })

  it('does not claim a PTY recording for a native tool, and has no limits row for it', async () => {
    draw()
    const vim = within(await card('Vim'))
    expect(vim.getByTestId('tool-card-capture-vim').textContent).not.toMatch(/PTY/)
    expect(vim.queryByTestId('tool-card-limits-vim')).toBeNull()
  })

  it('names where a profile comes from, and the operator override that beats it', async () => {
    draw({ policy: policyFor(plugin([acme({ id: 'acme/other', executables: ['acmetool'], mode: 'pty' })]), { relayed: ['vim'] }) })
    const vim = within(await card('Vim'))
    expect(vim.getByTestId('tool-card-origin-vim').textContent).toBe('Shipped with RedLog')
    expect(vim.getByTestId('tool-card-mode-vim').textContent).toMatch(/Relayed.*Your override/)
    const p = within(await card('Acme SSH'))
    expect(p.getByTestId('tool-card-origin-acme/other').textContent).toBe('Plugin acme')
  })

  it('draws a plugin author’s text as text', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">'
    draw({ policy: policyFor(plugin([acme({ id: 'acme/evil', name: hostile, reason: hostile, executables: ['evilcmd'], mode: 'pty' })])) })
    expect((await screen.findAllByText(hostile, { exact: false })).length).toBeGreaterThan(0)
    expect(document.querySelector('img')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('does not throw on a profile whose name is not a string', async () => {
    const bad = acme({ id: 'acme/weird', name: { not: 'a string' }, executables: ['weirdcmd'], mode: 'pty' })
    draw({ policy: policyFor(plugin([bad])) })
    expect(await card('acme/weird')).toBeTruthy()
  })

  it('has no override, start, stop or enable control, and one rescan', async () => {
    draw()
    const region = await screen.findByTestId('tool-profile-cards')
    const names = within(region).queryAllByRole('button').map((b) => b.textContent)
    expect(names).toEqual(['Rescan'])
    expect(region.textContent).not.toMatch(/\b(start|stop|override this|enable|disable|pause)\b/i)
    expect(region.querySelector('input, select, [role="switch"], [role="checkbox"]')).toBeNull()
  })

  it('shows nothing for verification, which no profile carries', async () => {
    draw()
    const region = await screen.findByTestId('tool-profile-cards')
    expect(region.textContent).not.toMatch(/verif/i)
    for (const word of ['Not Configured', 'Ready', 'Recording', 'Degraded', 'Paused', 'Failed']) {
      expect(region.textContent).not.toContain(word)
    }
  })

  it('keeps the commands that have no profile, which the old list showed', async () => {
    draw({ policy: policyFor(null, { native: ['mytool'] }) })
    const other = await screen.findByTestId('tool-profile-others')
    expect(other.textContent).toMatch(/Native.*Shipped default.*nc/)
    expect(other.textContent).toMatch(/Native.*Your override.*mytool/)
    expect(other.textContent).not.toMatch(/\bvim\b/)
  })

  it('renders nothing, and does not throw, against a bridge that predates profiles', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    draw({ policy: { mode: 'auto', app: 'all', native: ['nc'], pty: [] } })
    await screen.findByText('Capture sources RedLog ships')
    expect(screen.queryByTestId('tool-profile-cards')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('the rescan', () => {
  afterEach(() => cleanup())

  it('runs once when the panel opens, as settings-open, and not again on re-render or focus', async () => {
    const { rescan, detect } = draw()
    await card('SSH')
    expect(rescan).toHaveBeenCalledTimes(1)
    expect(rescan).toHaveBeenCalledWith('settings-open')
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(detect).toHaveBeenCalled())
    expect(rescan).toHaveBeenCalledTimes(1)
  })

  it('runs as manual only when the button is pressed', async () => {
    const { rescan } = draw()
    const region = await screen.findByTestId('tool-profile-cards')
    await within(region).findByRole('button', { name: 'Rescan' })
    await waitFor(() => expect(within(region).getByRole('button', { name: 'Rescan' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(within(region).getByRole('button', { name: 'Rescan' }))
    await waitFor(() => expect(rescan).toHaveBeenCalledTimes(2))
    expect(rescan.mock.calls.map((c) => c[0])).toEqual(['settings-open', 'manual'])
  })

  it('says so when detection cannot be read, instead of showing profiles as not found', async () => {
    const policy = policyFor()
    ;(window as unknown as { redlog: unknown }).redlog = {
      platform: 'linux',
      hooks: { detect: async () => [], terminalPolicy: async () => policy },
      tools: { detection: async () => { throw new Error('ipc down') }, rescan: async () => { throw new Error('ipc down') } }
    }
    render(<HooksPanel hooks={[]} setHooks={() => {}} t={t} />)
    const c = within(await card('SSH'))
    await waitFor(() => expect(screen.getByTestId('tool-profile-cards').textContent).toContain('ipc down'))
    expect(c.getByTestId('tool-card-detection-ssh').textContent).not.toContain('Not found on PATH')
  })
})

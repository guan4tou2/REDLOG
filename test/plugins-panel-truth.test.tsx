// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import PluginsPanel from '../src/renderer/src/components/settings/PluginsPanel'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'

// #347: what the page shows must be what main has done. Disabling used to be
// drawn at once and written eight seconds later, with one toast that said both.

const toasts = vi.hoisted(() => ({
  plain: [] as Array<{ message: string; opts: unknown }>,
  undo: [] as Array<{ message: string; onUndo: () => void; opts: unknown }>
}))
vi.mock('../src/renderer/src/components/Toast', () => ({
  toast: (message: string, opts: unknown) => { toasts.plain.push({ message, opts }) },
  toastUndo: (message: string, onUndo: () => void, opts: unknown) => { toasts.undo.push({ message, onUndo, opts }) }
}))

const t = (key: string, vars?: Record<string, string | number>): string =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''))

type Status = 'active' | 'disabled'
const view = (id: string, status: Status = 'active') => ({
  officialAgent: id.startsWith('official-ai-'), id, name: `Plugin ${id}`, version: '1.0.0', description: '', author: 'x', source: 'user' as const,
  tier: 'declarative' as const, status, capabilities: [], contributes: []
})

const api = {
  officialAgents: vi.fn(), installOfficialAgent: vi.fn(), uninstallOfficialAgent: vi.fn(),
  list: vi.fn(), reload: vi.fn(), openFolder: vi.fn(), setEnabled: vi.fn(), grant: vi.fn(), revoke: vi.fn()
}
const draw = (): void => {
  ;(window as unknown as { redlog: unknown }).redlog = { plugins: api }
  render(<PluginsPanel t={t} />)
}
// Every control lives in the plugin's detail now (one column: list, then detail),
// so a test that presses Disable or Review first chooses the row.
const drawOpen = async (): Promise<void> => {
  draw()
  fireEvent.click((await screen.findAllByTestId(/^plugin-details-/))[0])
}
const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('the plugins page shows what main has done', () => {
  beforeEach(() => {
    toasts.plain.length = 0; toasts.undo.length = 0
    Object.values(api).forEach((f) => f.mockReset())
    api.officialAgents.mockResolvedValue([])
  })
  afterEach(() => cleanup())

  it('writes a disable at once, and calls it disabled only after main says so', async () => {
    const wait = deferred<ReturnType<typeof view>[]>()
    api.list.mockResolvedValue([view('a')])
    api.setEnabled.mockReturnValue(wait.promise)
    await drawOpen()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    // Written now, not after a timer…
    expect(api.setEnabled).toHaveBeenCalledWith('a', false)
    // …and not yet drawn as disabled, because main has not answered.
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
    expect(toasts.undo).toHaveLength(0)
    await act(async () => { wait.resolve([view('a', 'disabled')]) })
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeTruthy()
    expect(toasts.undo).toHaveLength(1)
  })

  it('says what a disable does and does not do, and that it is global', async () => {
    api.list.mockResolvedValue([view('a')])
    api.setEnabled.mockResolvedValue([view('a', 'disabled')])
    await drawOpen()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(toasts.undo).toHaveLength(1))
    const why = JSON.stringify(toasts.undo[0].opts)
    expect(why).toContain('every project')
    expect(why).toContain('does not remove shell hooks')
    expect(why).not.toMatch(/Not written yet|8 seconds/)
    expect(screen.getByTestId('plugins-global-note').textContent).toContain('every project')
  })

  it('makes Undo an explicit re-enable', async () => {
    api.list.mockResolvedValue([view('a')])
    api.setEnabled.mockResolvedValueOnce([view('a', 'disabled')]).mockResolvedValueOnce([view('a', 'active')])
    await drawOpen()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(toasts.undo).toHaveLength(1))
    await act(async () => { toasts.undo[0].onUndo() })
    expect(api.setEnabled).toHaveBeenLastCalledWith('a', true)
    expect(await screen.findByRole('button', { name: 'Disable' })).toBeTruthy()
  })

  it('does not leave a switch drawn as flipped when main refuses, and reads the real list back', async () => {
    api.list.mockResolvedValue([view('a')])
    api.setEnabled.mockRejectedValue(new Error('state.json is read-only'))
    await drawOpen()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(toasts.plain).toHaveLength(1))
    expect(toasts.plain[0].message).toBe('Could not disable Plugin a')
    expect(JSON.stringify(toasts.plain[0].opts)).toContain('state.json is read-only')
    expect(toasts.undo).toHaveLength(0)
    // Read back, and still enabled — the button is usable again.
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
    const again = await screen.findByRole('button', { name: 'Disable' }) as HTMLButtonElement
    expect(again.disabled).toBe(false)
  })

  it('keeps a rejected reload from leaving the page busy', async () => {
    api.list.mockResolvedValue([view('a')])
    api.reload.mockRejectedValue(new Error('ipc closed'))
    draw()
    await screen.findByTestId('plugin-details-a')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(toasts.plain.some((x) => x.message === 'Could not reload plugins')).toBe(true))
    expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says a list that failed to load is not an empty list, and retries', async () => {
    api.list.mockRejectedValueOnce(new Error('main not ready')).mockResolvedValueOnce([view('a')])
    draw()
    const alert = await screen.findByTestId('plugins-load-error')
    expect(alert.textContent).toContain('main not ready')
    expect(alert.textContent).toContain('does not mean there are none')
    expect(screen.queryByText(/No plugins found/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('plugin-details-a')).toBeTruthy()
    expect(screen.queryByTestId('plugins-load-error')).toBeNull()
  })

  it('shows "no plugins" only when the list loaded and is empty', async () => {
    api.list.mockResolvedValue([])
    draw()
    expect(await screen.findByText(/No plugins found/)).toBeTruthy()
  })

  it('does not let a slow, older answer undo a newer decision', async () => {
    const slowReload = deferred<ReturnType<typeof view>[]>()
    api.list.mockResolvedValue([view('a')])
    api.reload.mockReturnValue(slowReload.promise)
    api.setEnabled.mockResolvedValue([view('a', 'disabled')])
    draw()
    const row = await screen.findByTestId('plugin-details-a')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))          // starts first, answers last
    fireEvent.click(row)
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' })) // decided after
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeTruthy()
    // The reload finally answers with the list as it was before the disable.
    await act(async () => { slowReload.resolve([view('a', 'active')]) })
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
  })
  // The consent dialog said the plugin runs "in a separate process, walled off
  // from the evidence log, signing keys, and hash chain". It is loaded into the
  // main process with no isolation (core/plugins/types.ts says so).
  describe('consent', () => {
    const privileged = (id: string, over: Record<string, unknown> = {}) => ({
      ...view(id), tier: 'privileged' as const, status: 'needs-consent', capabilities: ['events:write'], ...over
    })

    it('tells the truth about isolation before the operator trusts code', async () => {
      api.list.mockResolvedValue([privileged('p', { source: 'bundled' })])
      await drawOpen()
      fireEvent.click(await screen.findByRole('button', { name: 'Review & trust' }))
      const body = (await screen.findByTestId('plugin-consent-dialog')).textContent ?? ''
      expect(body).toContain('main process')
      expect(body).toContain('not isolated')
      expect(body).toContain('evidence log')
      expect(body).not.toMatch(/separate process|walled off/)
    })

    // A plugin with no code that declares terminal profiles needs approval too,
    // and the dialog must not tell the operator it runs code: it says what a
    // profile can do, which is stop a tool being recorded.
    it('asks for approval of a plugin that only declares terminal profiles, without claiming it runs code', async () => {
      const profiles = (over: Record<string, unknown> = {}) =>
        ({ ...view('tp'), status: 'needs-consent', needsApproval: true, contributes: ['terminalProfiles'], ...over })
      api.list.mockResolvedValue([profiles()])
      api.grant.mockResolvedValue({ ok: true, plugins: [profiles({ status: 'active' })] })
      await drawOpen()
      expect(screen.queryByText(en['plugins.tier.privileged'])).toBeNull()
      fireEvent.click(await screen.findByRole('button', { name: 'Review & trust' }))
      const dialog = (await screen.findByTestId('plugin-consent-dialog')).textContent ?? ''
      expect(dialog).not.toMatch(/main process|runs? code|ships code/)
      expect(dialog).not.toContain(en['plugins.consentWarn'])
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
      await waitFor(() => expect(api.grant).toHaveBeenCalledWith('tp'))
      expect(await screen.findByRole('button', { name: 'Revoke trust' })).toBeTruthy()
    })

    // The operator approves what is on the screen, so the screen has to say it:
    // which tool, which commands, what happens to them, and why the plugin says so.
    const ligolo = { name: 'Ligolo-ng', mode: 'pty', executables: ['ligolo-proxy', 'ligolo-agent'], reason: 'Brings its own PTY' }
    const vimKeys = { name: 'Vim Keys', mode: 'native', executables: ['vim2'], reason: 'Full-screen editor' }
    const relayedTool = { name: 'Capture Me', mode: 'relayed', executables: ['capme'], reason: 'Plain output' }
    const declaring = (over: Record<string, unknown> = {}) =>
      ({ ...view('tp'), status: 'needs-consent', needsApproval: true, contributes: ['terminalProfiles'], terminalProfiles: [ligolo, vimKeys, relayedTool], ...over })

    it('lists each profile, one line each: the tool, its commands, what happens to them, and why', async () => {
      api.list.mockResolvedValue([declaring()])
      await drawOpen()
      fireEvent.click(await screen.findByRole('button', { name: 'Review & trust' }))
      const items = Array.from((await screen.findByTestId('plugin-consent-dialog')).querySelectorAll('li')).map((li) => li.textContent ?? '')
      expect(items).toHaveLength(3)
      expect(items[0]).toBe('Ligolo-ng (ligolo-proxy, ligolo-agent): recorded through a PTY — Brings its own PTY')
      expect(items[1]).toBe('Vim Keys (vim2): not recorded — Full-screen editor')
      expect(items[2]).toBe('Capture Me (capme): output captured — Plain output')
    })

    it('says the same in Chinese, from the same three keys', async () => {
      const tZh = (key: string, vars?: Record<string, string | number>): string =>
        ((zh as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''))
      api.list.mockResolvedValue([declaring()])
      ;(window as unknown as { redlog: unknown }).redlog = { plugins: api }
      render(<PluginsPanel t={tZh} />)
      fireEvent.click((await screen.findAllByTestId(/^plugin-details-/))[0])
      fireEvent.click(await screen.findByRole('button', { name: zh['plugins.review'] }))
      const items = Array.from((await screen.findByTestId('plugin-consent-dialog')).querySelectorAll('li')).map((li) => li.textContent ?? '')
      expect(items).toEqual([
        'Ligolo-ng（ligolo-proxy, ligolo-agent）：透過 PTY 記錄 — Brings its own PTY',
        'Vim Keys（vim2）：不會被記錄 — Full-screen editor',
        'Capture Me（capme）：擷取輸出 — Plain output'
      ])
    })

    // A plugin that ships a tailer and also declares profiles is both. The code
    // warning was all the dialog said, and the profiles were approved unseen.
    it('shows the profiles of a plugin that also runs code, under the code warning', async () => {
      api.list.mockResolvedValue([privileged('p', { source: 'bundled', contributes: ['tailers', 'terminalProfiles'], terminalProfiles: [vimKeys] })])
      await drawOpen()
      fireEvent.click(await screen.findByRole('button', { name: 'Review & trust' }))
      const dialog = await screen.findByTestId('plugin-consent-dialog')
      expect(dialog.textContent).toContain('not isolated')
      expect(dialog.textContent).toContain(en['plugins.consentProfilesToo'])
      expect(Array.from(dialog.querySelectorAll('li')).map((li) => li.textContent)).toContain('Vim Keys (vim2): not recorded — Full-screen editor')
      expect(screen.getByRole('button', { name: 'Trust & run' })).toBeTruthy()
    })

    // A user's tailer never runs, so there is no code to approve, but its
    // profiles are still the operator's to approve: no Review button would have
    // left them with no way to.
    it('a third-party tailer that also declares profiles can be reviewed, and the dialog claims no code', async () => {
      api.list.mockResolvedValue([privileged('t', {
        source: 'user', contributes: ['tailers', 'terminalProfiles'], terminalProfiles: [vimKeys],
        report: { tailers: { state: 'rejected', reason: 'Third-party tailers are not supported' } }
      })])
      await drawOpen()
      fireEvent.click(await screen.findByRole('button', { name: 'Review & trust' }))
      const dialog = (await screen.findByTestId('plugin-consent-dialog')).textContent ?? ''
      expect(dialog).toContain('Vim Keys (vim2)')
      expect(dialog).not.toMatch(/main process|not isolated/)
      expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    })

    // #499: a capture RedLog installs becomes a script in the operator's shell
    // or in Claude Code, so it is approved like a profile is: from this dialog,
    // line by line, with no claim that it runs inside RedLog.
    it('lists the hooks a plugin would install, and claims neither code in RedLog nor tool profiles', async () => {
      const installing = (over: Record<string, unknown> = {}) => ({
        ...view('hk'), status: 'needs-consent', needsApproval: true, contributes: ['capture'], terminalProfiles: [],
        captureInstalls: [{ name: 'Acme Shell', installMethod: 'shell-source' }, { name: 'Acme Agent', installMethod: 'claude-settings' }],
        report: { capture: { accepted: 0, rejected: [], waiting: true } }, ...over
      })
      api.list.mockResolvedValue([installing()])
      api.grant.mockResolvedValue({ ok: false, error: 'plugin failed to load', plugins: [installing()] })
      draw()
      // Spec 065: the report lives in the detail panel, not the row.
      fireEvent.click(await screen.findByTestId('plugin-details-hk'))
      expect((await screen.findByTestId('plugin-results-capture-hk')).textContent).toBe(en['plugins.results.captureWaiting'])
      fireEvent.click(screen.getByTestId('plugin-detail-review-hk'))
      const dialog = await screen.findByTestId('plugin-consent-dialog')
      expect(dialog.textContent).toContain(en['plugins.consentTitleInstall'])
      expect(dialog.textContent).not.toMatch(/main process|not isolated|tool profile|terminal treats/)
      expect(Array.from(dialog.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
        'Acme Shell: runs in every new shell',
        'Acme Agent: runs after every Claude Code Bash tool call'
      ])
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
      await waitFor(() => expect(toasts.plain.length).toBe(1))
      const opts = JSON.stringify(toasts.plain[0].opts)
      expect(opts).toContain(en['plugins.grantFailedWhyInstall'])
      expect(opts).not.toContain('tool profiles')
    })

    it('a refused approval of profiles does not say the plugin "stays unable to run"', async () => {
      api.list.mockResolvedValue([declaring()])
      api.grant.mockResolvedValue({ ok: false, error: 'plugin failed to load', plugins: [declaring()] })
      await drawOpen()
      fireEvent.click(await screen.findByRole('button', { name: 'Review & trust' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
      await waitFor(() => expect(toasts.plain.length).toBe(1))
      const opts = JSON.stringify(toasts.plain[0].opts)
      expect(opts).toContain(en['plugins.grantFailedWhyProfiles'])
      expect(opts).not.toContain('unable to run')
      expect(opts).toContain('plugin failed to load')
    })

    it('offers no consent for a third-party tailer, which is refused whatever is agreed', async () => {
      api.list.mockResolvedValue([privileged('t', { source: 'user', report: { tailers: { state: 'rejected', reason: 'Third-party tailers are not supported' } } })])
      draw()
      await screen.findByText('Plugin t')
      expect(screen.queryByRole('button', { name: 'Review & trust' })).toBeNull()
      fireEvent.click(screen.getByTestId('plugin-details-t'))
      expect((await screen.findByTestId('plugin-results-t')).textContent).toContain('not supported')
      expect(screen.queryByRole('button', { name: 'Review & trust' })).toBeNull()
    })

    it('does not blame the manifest when a grant is refused, and shows the real reason', async () => {
      api.list.mockResolvedValue([privileged('p', { source: 'bundled' })])
      api.grant.mockResolvedValue({ ok: false, error: 'plugin failed to load', plugins: [privileged('p', { source: 'bundled' })] })
      await drawOpen()
      fireEvent.click(await screen.findByRole('button', { name: 'Review & trust' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Trust & run' }))
      await waitFor(() => expect(toasts.plain.length).toBe(1))
      expect(JSON.stringify(toasts.plain[0].opts)).toContain('plugin failed to load')
      expect(JSON.stringify(toasts.plain[0].opts)).not.toContain('manifest may have changed')
    })
  })
})

// The snapshot the shell reads could not be updated: new terminals may still
// apply profiles the operator has just revoked, and the page must not say "done".
describe('when the shell\'s tool profiles could not be updated', () => {
  const stale = 'EBUSY: resource busy or locked, unlink terminal-profiles.json'
  const row = (over: Record<string, unknown> = {}) => ({ ...view('tp'), tier: 'declarative' as const, needsApproval: true, terminalProfiles: [], ...over })
  beforeEach(() => {
    toasts.plain.length = 0; toasts.undo.length = 0
    Object.values(api).forEach((f) => f.mockReset())
    api.officialAgents.mockResolvedValue([])
  })
  afterEach(() => cleanup())

  it('says so on the page, with the reason, when the list arrives with the failure', async () => {
    api.list.mockResolvedValue([row({ profilesError: stale })])
    draw()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('may still apply')
    expect(alert.textContent).toContain(stale)
  })

  it('says nothing when there is no failure', async () => {
    api.list.mockResolvedValue([row({ profilesError: null })])
    draw()
    await screen.findByText('Plugin tp')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a revoke that could not update them is not reported as plain success', async () => {
    api.list.mockResolvedValue([row()])
    api.revoke.mockResolvedValue([row({ status: 'needs-consent', profilesError: stale })])
    await drawOpen()
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke trust' }))
    await waitFor(() => expect(toasts.plain.length).toBe(1))
    expect(toasts.plain[0].message).toContain('may still apply')
    expect(JSON.stringify(toasts.plain[0].opts)).toContain(stale)
  })

  it('an approval that could not update them says so beside the success', async () => {
    const waiting = row({ status: 'needs-consent', terminalProfiles: [{ name: 'T', mode: 'pty', executables: ['t'], reason: 'r' }] })
    api.list.mockResolvedValue([waiting])
    api.grant.mockResolvedValue({ ok: true, profilesError: stale, plugins: [row({ profilesError: stale })] })
    await drawOpen()
    fireEvent.click(await screen.findByRole('button', { name: 'Review & trust' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(toasts.plain.length).toBe(1))
    expect(toasts.plain[0].message).toContain('may still apply')
  })
})

// Spec 066: the plugin page is the one place official integrations are installed,
// updated and removed. Each has exactly one row, installed or not, and a
// not-installed one is never drawn as a disabled plugin.
it('lists each official integration once, including the one that is not installed', async () => {
  api.list.mockResolvedValue([view('official-ai-claude-code'), view('third-party')])
  api.officialAgents.mockResolvedValue([
    { agentKind: 'claude-code', pluginId: 'official-ai-claude-code', name: 'Claude Code', source: {}, state: 'installed', installationId: 'i1' },
    { agentKind: 'codex', pluginId: 'official-ai-codex', name: 'Codex', source: {}, state: 'not-installed' }
  ])
  draw()
  await screen.findByText('Plugin third-party')
  expect(screen.getAllByText('Plugin official-ai-claude-code')).toHaveLength(1)
  expect(screen.getAllByText('Codex')).toHaveLength(1)
  expect(screen.getByTestId('plugin-state-official-ai-codex').textContent).toBe('Not installed')
  expect(screen.queryByTestId('plugin-detail-toggle-official-ai-codex')).toBeNull()
  cleanup()
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let getCaptureHealth: typeof import('../src/core/capture-health').getCaptureHealth
let configureCaptureHealth: typeof import('../src/core/capture-health').configureCaptureHealth
let invalidateHooksCache: typeof import('../src/core/capture-health').invalidateHooksCache
let hooksMod: typeof import('../src/core/hooks-manager')
let pluginsIndex: typeof import('../src/core/plugins/index')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const evMod = await import('../src/core/db/events')
  const chMod = await import('../src/core/capture-health')
  hooksMod = await import('../src/core/hooks-manager')
  pluginsIndex = await import('../src/core/plugins/index')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  insertEventRaw = evMod.insertEvent
  getCaptureHealth = chMod.getCaptureHealth
  configureCaptureHealth = chMod.configureCaptureHealth
  invalidateHooksCache = chMod.invalidateHooksCache
  dbAvailable = true
} catch { /* better-sqlite3 not built */ }

const describeDB = dbAvailable ? describe : describe.skip

const ins = (agentType: string, data: Record<string, unknown>) =>
  insertEventRaw(agentType, data, { operatorId: 'op' })

/** `unavailable` lists the ids whose runtime is NOT on this machine —
 *  `available` is a second axis, and the mitmproxy row reads that one. */
function mockHooks(installed: Record<string, boolean>, unavailable: string[] = []): void {
  invalidateHooksCache()
  vi.spyOn(hooksMod, 'detectHooks').mockReturnValue(
    Object.entries(installed).map(([id, inst]) => ({
      id, name: id, description: '', agentType: 'shell',
      installed: inst, available: !unavailable.includes(id),
      installMethod: 'shell-source' as const, hookFile: ''
    }))
  )
}

describeDB('capture-health', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cap-')); initDB(tmp)
    // The app loads the bundled pack plugins at startup; tests do not, and a
    // pack whose plugin is not active is left out of health (Spec 035).
    const active = (id: string) => ({ manifest: { id }, source: 'bundled', status: 'active' }) as never
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(
      [active('pack-host-monitors'), active('pack-ai-agents'), active('pack-windows-output')]
    )
  })
  afterEach(() => { closeDB(); fs.rmSync(tmp, { recursive: true, force: true }); vi.restoreAllMocks() })

  it('dark when no hooks installed and only system events exist', () => {
    mockHooks({ 'shell-zsh': false, 'shell-bash': false, 'claude-code': false })
    ins('system', { subtype: 'session_start' })
    const h = getCaptureHealth()
    expect(h.verdict).toBe('dark')
    expect(h.hasRecorded).toBe(false)
  })

  it('E3: a plugin producer that declares `emits` gets a real active/idle feed readout', () => {
    // pcap-capture emits scanner.packet_flow. detectHooks carries agentType + emits.
    invalidateHooksCache()
    vi.spyOn(hooksMod, 'detectHooks').mockReturnValue([
      { id: 'shell-zsh', name: 'shell-zsh', description: '', agentType: 'shell', installed: true, available: true, installMethod: 'shell-source' as const, hookFile: '' },
      { id: 'pcap-capture.pcap-tcpdump', name: 'pcap-capture', description: '', agentType: 'scanner', emits: ['packet_flow'], installed: false, available: true, installMethod: 'manual' as const, hookFile: '' },
      { id: 'transparent-proxy.mitmproxy-transparent', name: 'transparent-proxy', description: '', agentType: 'scanner', emits: ['http_request_start', 'http_response'], installed: false, available: true, installMethod: 'manual' as const, hookFile: '' }
    ])
    // pcap has fed a packet_flow just now; the transparent proxy never fed.
    ins('scanner', { subtype: 'packet_flow', src: '10.0.0.5', dst: '10.0.0.9', syn_only: true })
    const h = getCaptureHealth()

    const pcap = h.sources.find((s) => s.id === 'pcap-capture.pcap-tcpdump')
    expect(pcap?.informational).toBe(true)
    expect(pcap?.state).toBe('ready')        // it has delivered
    expect(pcap?.lastEventAt).not.toBeNull()

    const tproxy = h.sources.find((s) => s.id === 'transparent-proxy.mitmproxy-transparent')
    expect(tproxy?.state).toBe('off')        // declared emits, but never fed
    expect(tproxy?.lastEventAt).toBeNull()

    // A live plugin producer counts as recording (capture IS happening), and an
    // idle sibling still can't drag the verdict down.
    expect(h.hasRecorded).toBe(true)
    expect(h.verdict).not.toBe('dark')
  })

  it('E3: a RUNNING plugin producer (recent heartbeat) that stopped feeding tips the verdict amber', () => {
    // Healthy baseline from a core source, plus a plugin producer the operator
    // is running (heartbeat) but which hasn't fed. That IS a problem.
    mockHooks({ 'shell-zsh': true, 'pcap-capture.pcap-tcpdump': true })
    vi.spyOn(hooksMod, 'detectHooks').mockReturnValue([
      { id: 'shell-zsh', name: 'shell-zsh', description: '', agentType: 'shell', installed: true, available: true, installMethod: 'shell-source' as const, hookFile: '' },
      { id: 'pcap-capture.pcap-tcpdump', name: 'pcap-capture', description: '', agentType: 'scanner', emits: ['packet_flow'], installed: false, available: true, installMethod: 'manual' as const, hookFile: '' }
    ])
    ins('shell', { subtype: 'command_start', command: 'x' })          // core source fed → would be healthy
    ins('system', { subtype: 'producer_heartbeat', producer: 'pcap-capture' }) // pcap says: I'm running
    invalidateHooksCache()
    const h = getCaptureHealth()

    const pcap = h.sources.find((s) => s.id === 'pcap-capture.pcap-tcpdump')
    expect(pcap?.running).toBe(true)
    expect(pcap?.state).toBe('ready')  // it is running, so it can record
    // The one silence that still means something: this producer says it is
    // running, every 15 seconds, and is delivering nothing. That is a fault —
    // and it is the only clock left in the verdict.
    expect(h.verdict).toBe('partial')
  })

  it('E3: WITHOUT a heartbeat, an idle plugin producer still never tips the verdict', () => {
    // The #48/#49 guarantee: installed-but-not-run producers are invisible to
    // the verdict. Same shape as above minus the heartbeat → stays healthy.
    vi.spyOn(hooksMod, 'detectHooks').mockReturnValue([
      { id: 'shell-zsh', name: 'shell-zsh', description: '', agentType: 'shell', installed: true, available: true, installMethod: 'shell-source' as const, hookFile: '' },
      { id: 'pcap-capture.pcap-tcpdump', name: 'pcap-capture', description: '', agentType: 'scanner', emits: ['packet_flow'], installed: false, available: true, installMethod: 'manual' as const, hookFile: '' }
    ])
    ins('shell', { subtype: 'command_start', command: 'x' })
    invalidateHooksCache()
    const h = getCaptureHealth()
    const pcap = h.sources.find((s) => s.id === 'pcap-capture.pcap-tcpdump')
    expect(pcap?.running).toBeFalsy()
    expect(pcap?.state).toBe('off')
    expect(h.verdict).toBe('healthy')
  })

  it('E3: a plugin capture producer is surfaced as informational and never tips the verdict', () => {
    // Healthy baseline: the shell hook is installed AND fed recently.
    mockHooks({ 'shell-zsh': true, 'pcap-capture.pcap-tcpdump': true })
    ins('shell', { subtype: 'command_start', command: 'nmap 10.0.0.1' })
    const h = getCaptureHealth()

    // The plugin producer (namespaced id, dot) shows up as an informational,
    // display-only source carrying its own label.
    const plugin = h.sources.find((s) => s.id === 'pcap-capture.pcap-tcpdump')
    expect(plugin).toBeTruthy()
    expect(plugin?.informational).toBe(true)
    expect(plugin?.label).toBe('pcap-capture.pcap-tcpdump') // mockHooks uses id as name
    expect(plugin?.state).toBe('off')

    // It is INSTALLED but has never fed — the exact shape that would tip the
    // verdict to `partial` if it counted. It must not: verdict stays healthy.
    expect(h.verdict).toBe('healthy')
    // And it is excluded from the core source rows the verdict is built from.
    const core = h.sources.filter((s) => !s.informational)
    expect(core.every((s) => !s.id.includes('.'))).toBe(true)
  })

  it('E3: an idle plugin producer alone cannot make the verdict partial', () => {
    // No core source fed; only an installed-but-idle plugin producer. Without
    // the informational exclusion this would read as "wired but silent" →
    // partial. The verdict must stay driven by the CORE sources only (here:
    // nothing wired/fed → dark), not amber-flip on an unrun manual producer.
    mockHooks({ 'pcap-capture.pcap-tcpdump': true })
    ins('system', { subtype: 'startup' }) // a non-capture event, proves nothing
    const h = getCaptureHealth()
    expect(h.verdict).toBe('dark')
    expect(h.sources.find((s) => s.id === 'pcap-capture.pcap-tcpdump')?.informational).toBe(true)
  })

  // Set up and nothing has come through is not a fault. A proxy with no
  // traffic is a proxy nobody has sent traffic to; a terminal with no commands
  // is an operator who has not typed. The verdict grades whether capture CAN
  // run, and `recording` reports, separately, whether anything has.
  it('is healthy when set up, even with nothing recorded yet', () => {
    mockHooks({ 'shell-zsh': true, 'claude-code': false })
    const h = getCaptureHealth()
    expect(h.verdict).toBe('healthy')
    expect(h.hasRecorded).toBe(false)
    expect(h.sources.find((s) => s.id === 'terminal')?.state).toBe('ready')
  })

  it('healthy once a source has recorded something', () => {
    mockHooks({ 'shell-zsh': true, 'claude-code': false })
    ins('shell', { subtype: 'command_start', command: 'nmap', source: 'zsh' })
    const h = getCaptureHealth()
    expect(h.verdict).toBe('healthy')
    expect(h.hasRecorded).toBe(true)
    expect(h.sources.find((s) => s.id === 'terminal')?.state).toBe('ready')
  })

  // One row for both terminals: RedLog's own panes and the operator's own
  // shell are the same capture in two places, and which one a command came
  // from is on the command (`data.source`), not on a capture source.
  it('feeds the terminal row from a RedLog pane as readily as from the shell hook', () => {
    mockHooks({ 'shell-zsh': false, 'claude-code': false })
    ins('shell', { subtype: 'command_end', command: 'id', source: 'builtin-terminal' })
    const h = getCaptureHealth()
    const terminal = h.sources.find((s) => s.id === 'terminal')
    expect(terminal?.state).toBe('ready')
    // No hook installed, and the row still does not read "not set up":
    // RedLog's own pane is the capability, and it is recording.
    expect(terminal?.installed).toBe(false)
    expect(h.sources.find((s) => s.id === 'builtin-terminal')).toBeUndefined()
  })

  // Spec 052 T017. The terminal row has always been able to say whether a
  // command has arrived; it could not say whether this machine's terminals
  // are enrolled at all. Those are different questions — an enrolled terminal
  // that nobody has typed in yet is working perfectly and has recorded
  // nothing — and the card needs the second one to tell "RedLog's panes only"
  // from "this machine's terminals too".
  describe('enrolled terminals', () => {
    let home: string
    let realHome: string | undefined
    let realProfile: string | undefined
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-home-'))
      realHome = process.env.HOME; realProfile = process.env.USERPROFILE
      process.env.HOME = home; process.env.USERPROFILE = home
    })
    afterEach(() => {
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome
      if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile
      fs.rmSync(home, { recursive: true, force: true })
    })

    const enroll = async (sessionId: string, recording: boolean) => {
      const mod = await import('../src/core/terminal-enrollment')
      mod.writeTerminalEnrollment(home, {
        sessionId, mode: 'auto', recording, engagementId: 'eng-1', operatorId: 'op', startedAt: Date.now()
      })
    }

    it('says nothing when nothing has enrolled', () => {
      mockHooks({ 'shell-zsh': false })
      expect(getCaptureHealth().sources.find((s) => s.id === 'terminal')?.enrolled).toBeUndefined()
    })

    it('counts the terminals and how many of them are recording', async () => {
      mockHooks({ 'shell-zsh': true })
      await enroll('pane-1', true)
      await enroll('pane-2', false)   // stopped on purpose — FR-022, not a fault
      expect(getCaptureHealth().sources.find((s) => s.id === 'terminal')?.enrolled)
        .toEqual({ total: 2, recording: 1 })
    })
  })

  it('does not count opening a pane as having recorded a command', () => {
    // Opening a pane writes a session_start. The terminal can record — that is
    // what `ready` says — but nothing has been recorded, which is what an
    // empty `lastEventAt` says. Two facts, two fields.
    mockHooks({ 'shell-zsh': false, 'claude-code': false })
    ins('shell', { subtype: 'session_start', source: 'builtin-terminal' })
    const h = getCaptureHealth()
    const terminal = h.sources.find((s) => s.id === 'terminal')
    expect(terminal?.lastEventAt).toBeNull()
    expect(terminal?.state).toBe('ready')
    expect(h.hasRecorded).toBe(false)
  })

  // v0.9.7: the `claude-code` row is gone. That hook was retired in v0.7.3 —
  // the script is a no-op stub, its detectHooks() entry is commented out —
  // so the row could never report `installed` and rendered as a permanent
  // idle with an Install button that did nothing. Agent coverage now comes
  // from the transcript tailer, which sees every tool, not just Bash.
  it('reports agent activity through the tailer row, not a claude-code row', () => {
    mockHooks({ 'shell-zsh': false })
    configureCaptureHealth({ packs: { aiAgents: true } })
    ins('agent', { subtype: 'tool_call', tool_name: 'Bash' })
    const h = getCaptureHealth()
    expect(h.sources.find((s) => s.id === 'claude-code')).toBeUndefined()
    expect(h.sources.find((s) => s.id === 'agent-tailer')?.state).toBe('ready')
  })

  // v0.9.7: DNS and HTTP are the same addon (hooks/mitmproxy-addon.py),
  // switched by how mitmdump is run. One row, fed by either stream.
  it('folds DNS events into the mitmproxy row', () => {
    mockHooks({ 'shell-zsh': false })
    ins('dns', { subtype: 'dns_query', query: 'example.test' })
    const h = getCaptureHealth()
    expect(h.sources.find((s) => s.id === 'dns')).toBeUndefined()
    expect(h.sources.find((s) => s.id === 'mitmproxy')?.state).toBe('ready')
  })

  // v0.9.7: installation and activation are separate axes.
  it('reports a switched-off source as off, not merely unset', () => {
    mockHooks({ 'shell-zsh': false })
    // Spec 035: sources switch by pack. Host monitors off, AI agents on.
    configureCaptureHealth({ packs: { hostMonitors: false, aiAgents: true } })
    const h = getCaptureHealth()
    expect(h.sources.find((s) => s.id === 'clipboard')?.state).toBe('off')
    expect(h.sources.find((s) => s.id === 'clipboard')?.enabled).toBe(false)
    // Switched on and nothing has come through it yet: it can record, which
    // is all this axis claims. Its silence is reported as an empty
    // `lastEventAt`, not as a second state.
    expect(h.sources.find((s) => s.id === 'agent-tailer')?.state).toBe('ready')
  })

  it('a switched-off source does not drag the verdict to partial', () => {
    mockHooks({ 'shell-zsh': false })
    // Feed the monitor, then switch it off: previously "expected but silent"
    // pinned the verdict to partial forever after.
    ins('process', { subtype: 'process_spawn', command: 'bash' })
    ins('scanner', { subtype: 'http_request', url: 'https://x' })
    configureCaptureHealth({ packs: { hostMonitors: false } })
    const h = getCaptureHealth()
    expect(h.sources.find((s) => s.id === 'process-monitor')?.state).toBe('off')
    expect(h.verdict).toBe('healthy')
  })

  it('recognises mitmproxy scanner events even though it has no install flag', () => {
    mockHooks({ 'shell-zsh': false, 'claude-code': false })
    ins('scanner', { subtype: 'http_request', url: 'https://x' })
    const h = getCaptureHealth()
    expect(h.verdict).toBe('healthy')
    expect(h.sources.find((s) => s.id === 'mitmproxy')?.state).toBe('ready')
  })

  // v0.9.8: getCaptureHealth is cached for 750 ms — it runs eleven indexed
  // probes plus a hooks check, and is hit by the Dashboard poll, the
  // StatusBar, every REST /api/status and every agent calling redlog_status.
  // Anything that changes what it reports has to drop the cache, or the
  // readout lags behind the thing it is reporting on.
  it('a config change is visible immediately, not after the cache TTL', () => {
    mockHooks({ 'shell-zsh': false })
    // The clipboard is ticked explicitly: it does not come on with the pack (#224).
    configureCaptureHealth({ packs: { hostMonitors: true }, packMembers: { clipboard: true } })
    expect(getCaptureHealth().sources.find((s) => s.id === 'clipboard')?.enabled).toBe(true)
    configureCaptureHealth({ packs: { hostMonitors: false }, packMembers: { clipboard: true } })
    expect(getCaptureHealth().sources.find((s) => s.id === 'clipboard')?.enabled).toBe(false)
  })
})

// Three ways this panel told an operator something that was not true, all
// found by walking a real Windows install end to end.
describeDB('capture-health tells the truth about live sources', () => {
  let tmp: string
  let noteCaptureError: typeof import('../src/core/capture-health').noteCaptureError
  let clearCaptureError: typeof import('../src/core/capture-health').clearCaptureError
  beforeEach(async () => {
    const ch = await import('../src/core/capture-health')
    noteCaptureError = ch.noteCaptureError; clearCaptureError = ch.clearCaptureError
    clearCaptureError('screenshot')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cap2-')); initDB(tmp)
    const active = (id: string) => ({ manifest: { id }, source: 'bundled', status: 'active' }) as never
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(
      [active('pack-host-monitors'), active('pack-ai-agents'), active('pack-windows-output')]
    )
  })
  afterEach(() => {
    clearCaptureError('screenshot')
    closeDB(); fs.rmSync(tmp, { recursive: true, force: true }); vi.restoreAllMocks()
  })

  // On Windows `shell-zsh` is never installed, and `checkInstalled` returns a
  // boolean, so `a ?? b ?? c` stopped at `false` and the row claimed the shell
  // hook was absent while PowerShell commands were landing.
  it('counts the shell hook installed when ANY shell hook is, not just the first', () => {
    mockHooks({ 'shell-zsh': false, 'shell-bash': false, 'shell-powershell': true })
    ins('shell', { subtype: 'command_end', command: 'whoami' })
    const terminal = getCaptureHealth().sources.find((s) => s.id === 'terminal')
    expect(terminal?.installed).toBe(true)
    expect(terminal?.state).toBe('ready')
  })

  // The managed proxy runs the mitmproxy addon with `-s <path>` rather than
  // installing the standalone hook, so the hook's own `installed` is false by
  // design while HTTP events pour in. "absent" over a source that fed seconds
  // ago is the one reading this panel must never produce.
  it('never calls a source unset while it is still feeding', () => {
    mockHooks({ 'shell-zsh': false, mitmproxy: false }, ['mitmproxy'])
    ins('scanner', { subtype: 'http_request_start', url: 'https://example.com/', method: 'GET' })
    const mitm = getCaptureHealth().sources.find((s) => s.id === 'mitmproxy')
    expect(mitm?.installed).toBe(false)
    expect(mitm?.state).toBe('ready')
  })

  // mitmproxy's installMethod is `manual`, and checkInstalled() returns false
  // for every manual hook unconditionally — so this row's `installed` said
  // nothing about the machine it was running on. It was false with mitmdump on
  // PATH, the managed proxy up and requests landing, and the Dashboard's
  // HTTP(S) line read 未安裝 mitmproxy through all of it. The honest question
  // is whether mitmdump is here, which is `available`.
  it('calls mitmproxy installed when mitmdump is on the machine, not when a manual hook says so', () => {
    mockHooks({ 'shell-zsh': false, mitmproxy: false })
    const mitm = getCaptureHealth().sources.find((s) => s.id === 'mitmproxy')
    expect(mitm?.installed).toBe(true)
    // Able, not missing: there is nothing left for the operator to install.
    expect(mitm?.state).toBe('ready')
  })

  it('calls mitmproxy unset only when mitmdump is missing', () => {
    mockHooks({ 'shell-zsh': false, mitmproxy: false }, ['mitmproxy'])
    const mitm = getCaptureHealth().sources.find((s) => s.id === 'mitmproxy')
    expect(mitm?.installed).toBe(false)
    expect(mitm?.state).toBe('unset')
  })

  // A camera that cannot see the screen is not a dark log.
  it('a capture failure marks that source, and tips the verdict amber — not dark', () => {
    mockHooks({ 'shell-zsh': true })
    ins('shell', { subtype: 'command_end', command: 'whoami' })
    expect(getCaptureHealth().verdict).toBe('healthy')

    noteCaptureError('screenshot', new Error('screen capture came back empty'))
    const h = getCaptureHealth()
    const shot = h.sources.find((s) => s.id === 'screenshot')
    expect(shot?.state).toBe('error')
    expect(shot?.lastError?.message).toContain('came back empty')
    expect(h.verdict).toBe('partial')
    // It is the source's fault, not the database's: nothing here claims
    // evidence cannot be written.
    expect(h.lastDbError).toBeUndefined()

    clearCaptureError('screenshot')
    expect(getCaptureHealth().sources.find((s) => s.id === 'screenshot')?.state).not.toBe('error')
  })
})

// HTTP and DNS share one `mitmproxy` row — the addon serves both, in two
// modes, from two mitmdump processes. The row used to carry a `streams` note
// saying which of them had traffic in the last ten minutes; that reported the
// target's traffic rather than RedLog's capture, and it was the last of that
// family left on the card.
describeDB('the mitmproxy row is fed by either of its two modes', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-streams-')); initDB(tmp)
    const active = (id: string) => ({ manifest: { id }, source: 'bundled', status: 'active' }) as never
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(
      [active('pack-host-monitors'), active('pack-ai-agents'), active('pack-windows-output')]
    )
    mockHooks({ 'shell-zsh': false, mitmproxy: false })
  })
  afterEach(() => { closeDB(); fs.rmSync(tmp, { recursive: true, force: true }); vi.restoreAllMocks() })

  const mitm = () => getCaptureHealth().sources.find((s) => s.id === 'mitmproxy')

  it('counts an HTTP request', () => {
    ins('scanner', { subtype: 'http_request_start', url: 'https://example.com/', method: 'GET' })
    expect(mitm()?.state).toBe('ready')
    expect(mitm()?.lastEventAt).not.toBeNull()
  })

  it('counts a DNS query, with no separate row for it', () => {
    ins('dns', { subtype: 'dns_query', query_name: 'example.com' })
    expect(mitm()?.lastEventAt).not.toBeNull()
    expect(getCaptureHealth().sources.find((s) => s.id === 'dns')).toBeUndefined()
  })

  // The connection monitor also writes agent_type='scanner'; it must not read
  // as HTTP traffic.
  it('does not read a socket-table row as HTTP traffic', () => {
    ins('scanner', { subtype: 'connection', remote_addr: '10.0.0.5:443' })
    expect(mitm()?.lastEventAt).toBeNull()
  })
})

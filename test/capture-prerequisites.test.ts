import { describe, it, expect, vi } from 'vitest'

// #688: the probes are pure over platform, env and the OS answer. The real
// TCC call (systemPreferences.getMediaAccessStatus) is not exercised here.

vi.mock('electron', () => ({ ipcMain: {}, shell: {}, systemPreferences: {} }))

const {
  screenRecordingPrerequisite, connectionTablePrerequisite, socketTableCommand,
  isOpenablePrerequisiteUrl, SCREEN_RECORDING_PANE
} = await import('../src/main/services/capture-prerequisites')

const mac = (status: string | null) =>
  screenRecordingPrerequisite({ platform: 'darwin', env: {}, readStatus: () => status })

describe('screen recording prerequisite', () => {
  it('granted on macOS when TCC says granted', () => {
    expect(mac('granted')).toEqual({ id: 'screen-recording', state: 'granted' })
  })

  it('missing on denied or restricted, with the privacy pane as the fix', () => {
    for (const s of ['denied', 'restricted']) {
      expect(mac(s)).toEqual({ id: 'screen-recording', state: 'missing', fix: { kind: 'open', url: SCREEN_RECORDING_PANE } })
    }
  })

  it('unknown when not yet asked, or when the status cannot be read', () => {
    expect(mac('not-determined').state).toBe('unknown')
    expect(mac(null).state).toBe('unknown')
  })

  it('unknown on Wayland, not-applicable on X11 and Windows; never asks TCC off macOS', () => {
    const readStatus = vi.fn(() => 'denied')
    expect(screenRecordingPrerequisite({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' }, readStatus }).state).toBe('unknown')
    expect(screenRecordingPrerequisite({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11' }, readStatus }).state).toBe('not-applicable')
    expect(screenRecordingPrerequisite({ platform: 'win32', env: {}, readStatus }).state).toBe('not-applicable')
    expect(readStatus).not.toHaveBeenCalled()
  })
})

describe('connection table prerequisite', () => {
  it('names the command the monitor runs on each platform', () => {
    expect(socketTableCommand('linux')).toBe('ss')
    expect(socketTableCommand('darwin')).toBe('netstat')
    expect(socketTableCommand('win32')).toBe('netstat')
    expect(socketTableCommand('freebsd')).toBeNull()
    expect(connectionTablePrerequisite({ platform: 'freebsd', found: () => false })).toBeNull()
  })

  it('granted when the command is on PATH', () => {
    expect(connectionTablePrerequisite({ platform: 'linux', found: (c) => c === 'ss' })).toEqual({ id: 'ss', state: 'granted' })
  })

  it('missing ss on Linux offers the install command; missing netstat offers nothing', () => {
    expect(connectionTablePrerequisite({ platform: 'linux', found: () => false }))
      .toEqual({ id: 'ss', state: 'missing', fix: { kind: 'copy', command: 'sudo apt install iproute2' } })
    expect(connectionTablePrerequisite({ platform: 'win32', found: () => false })).toEqual({ id: 'netstat', state: 'missing' })
  })
})

describe('openable settings URLs', () => {
  it('allows only the exact privacy pane', () => {
    expect(isOpenablePrerequisiteUrl(SCREEN_RECORDING_PANE)).toBe(true)
    expect(isOpenablePrerequisiteUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera')).toBe(false)
    expect(isOpenablePrerequisiteUrl('file:///etc/passwd')).toBe(false)
    expect(isOpenablePrerequisiteUrl(42)).toBe(false)
  })
})

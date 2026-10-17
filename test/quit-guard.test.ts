import { describe, it, expect } from 'vitest'
import { quitImpact, quitDialog, defaultQuitText, parseQuitText, allowQuit, isQuitAllowed } from '../src/main/quit-guard'

describe('quitting RedLog (#346)', () => {
  it('asks nothing when nothing live would stop', () => {
    expect(quitImpact({ terminals: 0, proxyState: 'stopped', project: 'p' })).toBeNull()
    expect(quitImpact({ terminals: 0, proxyState: undefined, project: null })).toBeNull()
  })

  it('names what a quit stops: built-in terminals and the managed proxy', () => {
    const impact = quitImpact({ terminals: 2, proxyState: 'running', project: 'acme' })!
    expect(impact).toEqual({ terminals: 2, proxyRunning: true, externalActive: false, project: 'acme' })
    const d = quitDialog(impact, defaultQuitText('en-US'))
    expect(d.message).toContain('acme')
    expect(d.detail).toContain('2 built-in terminal(s)')
    expect(d.detail).toContain('managed web capture proxy')
  })

  it('lists only what is actually live', () => {
    const onlyProxy = quitDialog(quitImpact({ terminals: 0, proxyState: 'running', project: null })!, defaultQuitText('en'))
    expect(onlyProxy.detail).not.toContain('built-in terminal')
    const onlyTerminals = quitDialog(quitImpact({ terminals: 1, proxyState: 'starting', project: null })!, defaultQuitText('en'))
    expect(onlyTerminals.detail).not.toContain('proxy:')
  })

  it('says external terminals are not closed, so it is not read as "everything stops"', () => {
    const d = quitDialog(quitImpact({ terminals: 1, proxyState: 'stopped', project: null })!, defaultQuitText('en'))
    expect(d.detail).toContain('outside RedLog keep running')
  })

  describe('a terminal opened outside RedLog that is recording', () => {
    const now = 1_000_000_000
    it('asks even when no built-in terminal or proxy is live', () => {
      const impact = quitImpact({ terminals: 0, proxyState: 'stopped', project: 'acme', externalLastEventAt: now - 60_000, now })
      expect(impact).toMatchObject({ terminals: 0, proxyRunning: false, externalActive: true })
      const d = quitDialog(impact!, defaultQuitText('en'))
      expect(d.detail).toContain('recorded a command in the last 10 minutes')
      expect(d.detail).toContain('go to no project')
      expect(d.detail).not.toContain('built-in terminal')
    })
    it('does not ask for one that has been quiet longer than the window', () => {
      expect(quitImpact({ terminals: 0, proxyState: 'stopped', project: 'acme', externalLastEventAt: now - 11 * 60_000, now })).toBeNull()
    })
    it('does not ask when it never recorded, or when no project is open', () => {
      expect(quitImpact({ terminals: 0, proxyState: 'stopped', project: 'acme', externalLastEventAt: null, now })).toBeNull()
      expect(quitImpact({ terminals: 0, proxyState: 'stopped', project: null, externalLastEventAt: now - 1000, now })).toBeNull()
    })
    it('states the consequence, not only the standing note, when other things stop too', () => {
      const impact = quitImpact({ terminals: 1, proxyState: 'running', project: 'acme', externalLastEventAt: now - 1000, now })!
      const d = quitDialog(impact, defaultQuitText('en'))
      expect(d.detail).toContain('1 built-in terminal(s)')
      expect(d.detail).toContain('go to no project')
      expect(d.detail).not.toContain('keep running; their commands are no longer recorded')
    })
  })

  it('makes the safe choice the first, the default, and what Escape does', () => {
    const d = quitDialog(quitImpact({ terminals: 1, proxyState: 'stopped', project: null })!, defaultQuitText('en'))
    expect(d.buttons).toEqual(['Stay in background', 'Stop and quit'])
    expect(d.defaultId).toBe(0)
    expect(d.cancelId).toBe(0)
  })

  it('follows the system language until the renderer sends its own', () => {
    expect(defaultQuitText('zh-TW').quit).toBe('停止並結束')
    expect(defaultQuitText('zh-Hant-TW').stay).toBe('留在背景')
    expect(defaultQuitText('de-DE').quit).toBe('Stop and quit')
  })

  it('rejects a malformed text payload instead of blanking the dialog', () => {
    const good = { title: 'a', message: 'b', terminals: 'c {{count}}', proxy: 'd', external: 'e', externalLive: 'x', stay: 'f', quit: 'g' }
    expect(parseQuitText(good)).toEqual(good)
    expect(parseQuitText({ ...good, quit: '' })).toBeNull()
    expect(parseQuitText({ ...good, stay: 3 })).toBeNull()
    expect(parseQuitText({ ...good, title: 'x'.repeat(401) })).toBeNull()
    expect(parseQuitText(null)).toBeNull()
    expect(parseQuitText('text')).toBeNull()
  })

  it('lets an update restart or OS shutdown through without a dialog', () => {
    expect(isQuitAllowed()).toBe(false)
    allowQuit()
    expect(isQuitAllowed()).toBe(true)
  })
})

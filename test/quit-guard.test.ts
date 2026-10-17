import { describe, it, expect } from 'vitest'
import { quitImpact, quitDialog, defaultQuitText, parseQuitText, allowQuit, isQuitAllowed } from '../src/main/quit-guard'

describe('quitting RedLog (#346)', () => {
  it('asks nothing when nothing live would stop', () => {
    expect(quitImpact({ terminals: 0, proxyState: 'stopped', project: 'p' })).toBeNull()
    expect(quitImpact({ terminals: 0, proxyState: undefined, project: null })).toBeNull()
  })

  it('names what a quit stops: built-in terminals and the managed proxy', () => {
    const impact = quitImpact({ terminals: 2, proxyState: 'running', project: 'acme' })!
    expect(impact).toEqual({ terminals: 2, proxyRunning: true, project: 'acme' })
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
    const good = { title: 'a', message: 'b', terminals: 'c {{count}}', proxy: 'd', external: 'e', stay: 'f', quit: 'g' }
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

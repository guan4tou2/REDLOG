import { describe, it, expect, afterEach, vi } from 'vitest'
import { isInsideDir } from '../src/core/paths'

// Swap process.platform for the Windows-specific cases. `platform` is
// non-writable in Node, so use Object.defineProperty; restore in afterEach.
function pretendPlatform(p: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  return () => Object.defineProperty(process, 'platform', original)
}

describe('isInsideDir', () => {
  let restore: (() => void) | null = null
  afterEach(() => { restore?.(); restore = null })

  describe('POSIX', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('accepts exact match', () => {
      restore = pretendPlatform('darwin')
      expect(isInsideDir('/a/b', '/a/b')).toBe(true)
    })

    it('accepts a nested file', () => {
      restore = pretendPlatform('darwin')
      expect(isInsideDir('/a/b', '/a/b/c/d.txt')).toBe(true)
    })

    it('rejects a parent-dir escape', () => {
      restore = pretendPlatform('darwin')
      expect(isInsideDir('/a/b', '/a/b/../evil')).toBe(false)
    })

    it('rejects a sibling with the same prefix (the old startsWith bug)', () => {
      restore = pretendPlatform('darwin')
      // /a/bevil starts-with /a/b but isn't inside it.
      expect(isInsideDir('/a/b', '/a/bevil/thing')).toBe(false)
    })

    it('rejects a totally different tree', () => {
      restore = pretendPlatform('darwin')
      expect(isInsideDir('/a/b', '/x/y')).toBe(false)
    })

    it('POSIX is case-sensitive', () => {
      restore = pretendPlatform('darwin')
      expect(isInsideDir('/A/B', '/a/b/c')).toBe(false)
    })
  })

  describe('Windows', () => {
    it('accepts differently-cased drive letter (the P1-2 bug)', () => {
      restore = pretendPlatform('win32')
      // Renderer round-trips a URL and hands us `c:\Users\...` when the
      // project dir is `C:\Users\...`. Old code rejected this.
      expect(isInsideDir('C:\\Users\\foo\\.redlog\\screenshots', 'c:\\users\\foo\\.redlog\\screenshots\\1.jpg')).toBe(true)
    })

    it('accepts a nested file with mixed separators', () => {
      restore = pretendPlatform('win32')
      expect(isInsideDir('C:\\a\\b', 'C:\\a\\b\\c\\d.txt')).toBe(true)
    })

    it('rejects a `..` escape', () => {
      restore = pretendPlatform('win32')
      expect(isInsideDir('C:\\a\\b', 'C:\\a\\b\\..\\evil')).toBe(false)
    })

    it('rejects a different drive letter entirely', () => {
      restore = pretendPlatform('win32')
      expect(isInsideDir('C:\\a\\b', 'D:\\a\\b\\c')).toBe(false)
    })

    it('rejects the same-prefix sibling attack', () => {
      restore = pretendPlatform('win32')
      expect(isInsideDir('C:\\a\\b', 'C:\\a\\bevil\\thing')).toBe(false)
    })
  })
})

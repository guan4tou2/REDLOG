// @vitest-environment jsdom
//
// usePersistentState is the shared read-once / write-on-change localStorage
// hook the clean scalar toggles migrated onto. What matters here: it honors the
// call site's own parse/serialize (so a migrated site keeps identical coercion,
// including how it treats a missing or corrupt value) and it survives storage
// that is absent or throws.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { usePersistentState } from '../src/renderer/src/lib/usePersistentState'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

const val = (): string => screen.getByTestId('v').textContent ?? ''
const click = (): void => { fireEvent.click(screen.getByTestId('v')) }

// Mirrors the TerminalView font-size site: 8–32 clamp, default 13.
function NumberHarness({ k }: { k: string }): JSX.Element {
  const [n, setN] = usePersistentState<number>(k, 13, {
    parse: (raw) => {
      const v = parseInt(raw || '')
      return Number.isFinite(v) && v >= 8 && v <= 32 ? v : 13
    }
  })
  return <button data-testid="v" onClick={() => setN(n + 1)}>{n}</button>
}

// Mirrors the two Timeline boolean conventions.
function BoolHarness({ k, initial, mode }: { k: string; initial: boolean; mode: 'eq1' | 'ne0' }): JSX.Element {
  const [b, setB] = usePersistentState<boolean>(k, initial, {
    parse: (raw) => (mode === 'eq1' ? raw === '1' : raw !== '0'),
    serialize: (v) => (v ? '1' : '0')
  })
  return <button data-testid="v" onClick={() => setB(!b)}>{String(b)}</button>
}

// Plain string state, no codec.
function StringHarness({ k }: { k: string }): JSX.Element {
  const [s] = usePersistentState<string>(k, 'local')
  return <span data-testid="v">{s}</span>
}

describe('usePersistentState', () => {
  it('reads an existing stored value through parse', () => {
    localStorage.setItem('fs', '20')
    render(<NumberHarness k="fs" />)
    expect(val()).toBe('20')
  })

  it('falls back to initial when the key is missing', () => {
    render(<NumberHarness k="fs" />)
    expect(val()).toBe('13')
  })

  it('falls back to initial when the stored value is out of range', () => {
    localStorage.setItem('fs', '999')
    render(<NumberHarness k="fs" />)
    expect(val()).toBe('13')
  })

  it('writes the initial value on mount and the new value on change', () => {
    render(<NumberHarness k="fs" />)
    expect(localStorage.getItem('fs')).toBe('13')
    click()
    expect(val()).toBe('14')
    expect(localStorage.getItem('fs')).toBe('14')
  })

  it('honors the default-off boolean convention (=== "1")', () => {
    render(<BoolHarness k="b" initial={false} mode="eq1" />)
    expect(val()).toBe('false')
    expect(localStorage.getItem('b')).toBe('0')
    click()
    expect(localStorage.getItem('b')).toBe('1')
  })

  it('reads a stored "1" as true under the default-off convention', () => {
    localStorage.setItem('b', '1')
    render(<BoolHarness k="b" initial={false} mode="eq1" />)
    expect(val()).toBe('true')
  })

  it('honors the default-on boolean convention (!== "0")', () => {
    render(<BoolHarness k="f" initial={true} mode="ne0" />)
    expect(val()).toBe('true')
  })

  it('reads a stored "0" as false under the default-on convention', () => {
    localStorage.setItem('f', '0')
    render(<BoolHarness k="f" initial={true} mode="ne0" />)
    expect(val()).toBe('false')
  })

  it('stores plain string state verbatim with the String() default serializer', () => {
    localStorage.setItem('tz', 'utc')
    render(<StringHarness k="tz" />)
    expect(val()).toBe('utc')
  })

  it('renders the initial value without crashing when getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    render(<NumberHarness k="fs" />)
    expect(val()).toBe('13')
  })

  it('keeps updating state when setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    render(<NumberHarness k="fs" />)
    click()
    expect(val()).toBe('14')
  })
})

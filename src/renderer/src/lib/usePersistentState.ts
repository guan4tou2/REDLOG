import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

// One typed home for the "read a scalar from localStorage once on mount, write
// it back whenever it changes" pattern that a handful of call sites had each
// re-derived by hand. The load-bearing storage in Timeline.tsx — project-scoped
// keys, legacy migration, debounced writes — deliberately does NOT use this;
// that logic a generic hook has no business owning.
//
// Storage can be missing or blocked (private windows, cleared site data, a
// policy that throws on access), so every read and write is wrapped and the
// hook falls back to the caller's value rather than letting the component
// crash — the same discipline the rest of the renderer already follows.
//
// `parse` and `serialize` keep coercion at the call site so each migration
// preserves its exact behavior, including how it treats an absent or corrupt
// value: a boolean toggle that defaults on maps a missing key differently from
// one that defaults off, and only the call site knows which it is.

export interface PersistentStateOptions<T> {
  // Maps the raw stored string (or null when the key is missing or unreadable)
  // to a value. Required for anything but plain string state.
  parse?: (raw: string | null) => T
  // Maps the value back to the string to store. Defaults to String().
  serialize?: (value: T) => string
}

export function usePersistentState<T>(
  key: string,
  initial: T,
  opts: PersistentStateOptions<T> = {}
): [T, Dispatch<SetStateAction<T>>] {
  const { parse, serialize } = opts
  const [value, setValue] = useState<T>(() => {
    let raw: string | null = null
    try { raw = localStorage.getItem(key) } catch { raw = null }
    if (parse) return parse(raw)
    // No codec: the stored string is the value; fall back when it is absent.
    return raw === null ? initial : (raw as unknown as T)
  })
  // Mirrors the original hand-written writers, which also ran on mount and so
  // wrote the initial value straight back. `serialize` is intentionally out of
  // the dep list: call sites pass it inline, and including it would fire the
  // write on every render instead of only on a real value change.
  useEffect(() => {
    try {
      localStorage.setItem(key, serialize ? serialize(value) : String(value))
    } catch { /* storage unavailable — keep running */ }
  }, [key, value])
  return [value, setValue]
}

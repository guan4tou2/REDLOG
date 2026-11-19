interface TimingOptions {
  enabled: boolean
  now?: () => number
  write?: (line: string) => void
}

export function createStallTiming({ enabled, now = () => performance.now(), write = line => console.error(line) }: TimingOptions) {
  const totals = new Map<string, [number, number, number]>()
  // Diagnostics must never replace a call's return value or original error.
  const emit = (line: string) => { try { write(line) } catch { /* diagnostic sink closed */ } }
  const wrap = <T extends Function>(label: string, fn: T, perCall = true): T => {
    if (!enabled) return fn
    return function (this: unknown, ...args: unknown[]) {
      const start = now()
      try { return fn.apply(this, args) } finally {
        const ms = now() - start
        const s = totals.get(label) ?? [0, 0, 0]
        totals.set(label, [s[0] + 1, s[1] + ms, Math.max(s[2], ms)])
        if (perCall && ms >= 250) {
          try { emit(`[stall] ${Math.round(ms)}ms ${label} ${String(args[0]).slice(-48)}`) } catch { /* unprintable argument */ }
        }
      }
    } as unknown as T
  }
  return {
    wrap,
    summary(file: string) {
      if (!enabled) return
      const rows = [...totals].filter(([, s]) => s[1] >= 500)
        .map(([label, s]) => `${label} n=${s[0]} sum=${Math.round(s[1])} max=${Math.round(s[2])}`)
      if (rows.length) emit(`[stall-sum] ${file} ${rows.join('; ')}`)
    },
  }
}

interface InstallOptions extends TimingOptions {
  fs: object
  Database: Function
  statementPrototype: object
  replaceDatabase: (replacement: Function) => void
  syncBuiltinESMExports: () => void
}

// Dependencies and the enable flag are injected so the Windows path can be
// exercised locally without changing process.platform or the production gate.
export function installStallTiming(options: InstallOptions) {
  const timing = createStallTiming(options)
  const restore: Array<() => void> = []
  if (options.enabled) {
    const statementPrototype = options.statementPrototype
    const patch = (object: object, key: string, label: string, perCall = true) => {
      const target = object as Record<string, Function>
      const original = target[key]
      target[key] = timing.wrap(label, original, perCall)
      restore.push(() => { target[key] = original })
    }
    for (const key of ['fsyncSync', 'openSync', 'closeSync', 'writeFileSync', 'readFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'mkdtempSync']) {
      patch(options.fs, key, `fs.${key}`)
    }
    options.syncBuiltinESMExports()
    for (const key of ['pragma', 'exec', 'close']) patch(options.Database.prototype, key, `sqlite.${key}`)
    patch(statementPrototype, 'run', 'sqlite.run', false)
    // Keep path as the timed function's first argument, including for errors.
    const Database = new Proxy(options.Database, {
      construct(target, args, newTarget) {
        return timing.wrap('sqlite.open', () => Reflect.construct(target, args, newTarget)).call(null, args[0])
      },
      apply(target, receiver, args) {
        return timing.wrap('sqlite.open', () => Reflect.apply(target, receiver, args)).call(null, args[0])
      },
    })
    options.replaceDatabase(Database)
    restore.push(() => options.replaceDatabase(options.Database))
  }
  return {
    ...timing,
    restore() {
      for (const undo of restore.reverse()) undo()
      restore.length = 0
      if (options.enabled) options.syncBuiltinESMExports()
    },
  }
}

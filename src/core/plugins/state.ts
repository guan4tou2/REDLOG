import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Which plugins the operator has explicitly turned off. Separate from trust:
// a declarative plugin needs no consent to run, but the operator may still want
// to disable it. Privileged plugins that lose trust are gated regardless.

function statePath(): string {
  return join(homedir(), '.redlog', 'plugins', 'state.json')
}

function read(): { disabled: string[] } {
  const p = statePath()
  if (!existsSync(p)) return { disabled: [] }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return { disabled: Array.isArray(parsed?.disabled) ? parsed.disabled : [] }
  } catch {
    return { disabled: [] }
  }
}

function write(state: { disabled: string[] }): void {
  mkdirSync(join(homedir(), '.redlog', 'plugins'), { recursive: true })
  writeFileSync(statePath(), JSON.stringify(state, null, 2))
}

export function isDisabled(pluginId: string): boolean {
  return read().disabled.includes(pluginId)
}

export function setDisabled(pluginId: string, disabled: boolean): void {
  const state = read()
  const has = state.disabled.includes(pluginId)
  if (disabled && !has) state.disabled.push(pluginId)
  else if (!disabled && has) state.disabled = state.disabled.filter((id) => id !== pluginId)
  else return
  write(state)
}

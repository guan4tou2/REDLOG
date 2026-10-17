// Quitting RedLog is not closing its window. Closing hides it and the sources
// keep recording; quitting stops the built-in terminals and the managed proxy.
// When something is live, say so and let the operator choose (#346).

// A quit the operator did not ask for — an update restart, the OS shutting
// down — must not wait on a dialog: holding one open blocks the logout.
let quitAllowed = false
export function allowQuit(): void { quitAllowed = true }
export function isQuitAllowed(): boolean { return quitAllowed }

export interface QuitImpact {
  terminals: number
  proxyRunning: boolean
  project: string | null
}

/** What a quit would stop. Null means nothing is live, so there is nothing to
 *  ask: the quit goes ahead without a dialog. */
export function quitImpact(state: { terminals: number; proxyState: string | undefined; project: string | null }): QuitImpact | null {
  const proxyRunning = state.proxyState === 'running'
  if (state.terminals <= 0 && !proxyRunning) return null
  return { terminals: Math.max(0, state.terminals), proxyRunning, project: state.project }
}

export interface QuitText {
  title: string
  message: string
  /** Lines naming what stops; `{{count}}` and `{{project}}` are substituted. */
  terminals: string
  proxy: string
  external: string
  stay: string
  quit: string
}

const QUIT_TEXT_EN: QuitText = {
  title: 'Quit RedLog?',
  message: 'Closing the window keeps recording in the background. Quitting stops:',
  terminals: '{{count}} built-in terminal(s): their sessions end and their recordings are closed',
  proxy: 'The managed web capture proxy: tools routed through it lose the proxy',
  external: 'Terminals you opened outside RedLog keep running; their commands are no longer recorded.',
  stay: 'Stay in background',
  quit: 'Stop and quit'
}

const QUIT_TEXT_ZH_TW: QuitText = {
  title: '要結束 RedLog 嗎？',
  message: '關閉視窗會讓記錄繼續在背景進行。結束 App 會停止：',
  terminals: '{{count}} 個內建終端：工作階段結束，錄影一併收尾',
  proxy: '受管網頁擷取代理：經由它的工具會失去代理服務',
  external: '你在 RedLog 外開啟的終端不會被關閉，但之後的指令不再被記錄。',
  stay: '留在背景',
  quit: '停止並結束'
}

/** The renderer sends its current language's text; until it does, follow the
 *  system language rather than guessing English for everyone. */
export function defaultQuitText(systemLocale: string): QuitText {
  return systemLocale.toLowerCase().startsWith('zh') ? QUIT_TEXT_ZH_TW : QUIT_TEXT_EN
}

/** Accepts only plain non-empty strings for every field, so a malformed IPC
 *  payload cannot blank the dialog. */
export function parseQuitText(raw: unknown): QuitText | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const keys: Array<keyof QuitText> = ['title', 'message', 'terminals', 'proxy', 'external', 'stay', 'quit']
  const out = {} as QuitText
  for (const k of keys) {
    const v = r[k]
    if (typeof v !== 'string' || v.trim() === '' || v.length > 400) return null
    out[k] = v
  }
  return out
}

export function quitDialog(impact: QuitImpact, text: QuitText): {
  title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number
} {
  const lines: string[] = []
  if (impact.terminals > 0) lines.push(`• ${text.terminals.replace('{{count}}', String(impact.terminals))}`)
  if (impact.proxyRunning) lines.push(`• ${text.proxy}`)
  const head = impact.project ? `${impact.project}\n\n${text.message}` : text.message
  return {
    title: text.title,
    message: head,
    detail: `${lines.join('\n')}\n\n${text.external}`,
    // The safe choice is first, default and what Escape means.
    buttons: [text.stay, text.quit],
    defaultId: 0,
    cancelId: 0
  }
}

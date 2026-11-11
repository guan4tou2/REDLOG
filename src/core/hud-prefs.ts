// The HUD's settings. They are the operator's, not the engagement's: how big
// the text is or whether the bar is click-through does not change when the
// project does. They used to live in each project's config.yaml as `overlay:`,
// so every project had its own copy and the HUD changed under the operator on
// every switch. An `overlay:` block still present in an old project file is
// read once, to seed these when there are none yet, and ignored after that.
//
// Pure, so the renderer can share the shape; the file lives in
// src/main/services/hud-prefs.ts.

export interface HudPrefs {
  /** Whether the HUD opens when a project opens. The in-HUD ✕ and the tray
   *  only hide it until the next open (Spec 060 FR-014). */
  autoShow: boolean
  showMarkButton: boolean
  /** macOS: keep a Dock icon (opening the HUD otherwise makes the app Dock-less) */
  showInDock: boolean
  /** flash the whole HUD frame while the external IP is EXPOSED */
  flashOnExposed: boolean
  /** text scale multiplier for the whole HUD; 1.0 = default */
  scale: number
  /** the external IP an extra ~1.4× on top of `scale` */
  emphasizeExternalIp: boolean
  /** HUD is click-through and dimmed to `passThroughOpacity` */
  passThrough: boolean
  passThroughOpacity: number
}

export const DEFAULT_HUD_PREFS: Readonly<HudPrefs> = Object.freeze({
  autoShow: true,
  showMarkButton: true,
  showInDock: true,
  flashOnExposed: true,
  scale: 1.0,
  emphasizeExternalIp: false,
  passThrough: false,
  passThroughOpacity: 0.4
})

const BOOLEAN_KEYS = ['autoShow', 'showMarkButton', 'showInDock', 'flashOnExposed', 'emphasizeExternalIp', 'passThrough'] as const

/** `input` laid over `base`, key by key. A key of the wrong type, or a number
 *  out of range, keeps the base value: a hand-edited or truncated file cannot
 *  put the HUD somewhere unusable. */
export function mergeHudPrefs(base: Readonly<HudPrefs>, input: unknown): HudPrefs {
  const out: HudPrefs = { ...base }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  const r = input as Record<string, unknown>
  for (const k of BOOLEAN_KEYS) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
  if (typeof r.scale === 'number' && Number.isFinite(r.scale) && r.scale > 0) out.scale = r.scale
  if (typeof r.passThroughOpacity === 'number' && Number.isFinite(r.passThroughOpacity)
    && r.passThroughOpacity > 0 && r.passThroughOpacity <= 1) out.passThroughOpacity = r.passThroughOpacity
  return out
}

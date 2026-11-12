import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { contentSecurityPolicy } from '../src/core/csp'

// The packaged renderer's policy, read as directives rather than substrings,
// and the built html checked against it: a policy that would block the app's
// own entry script is as broken as one that lets anything through.

function parse(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(';').map((p) => p.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/)
    expect(out.has(name), `duplicate directive ${name}`).toBe(false)
    out.set(name, sources)
  }
  return out
}

describe('production CSP directives', () => {
  const csp = parse(contentSecurityPolicy({ dev: false }))

  it('runs only the app’s own script files: no inline, no eval, no remote origin', () => {
    expect(csp.get('script-src')).toEqual(["'self'"])
    expect(csp.get('default-src')).toEqual(["'self'"])
  })

  it('keeps unsafe-inline for styles only (xterm and the HUD inject <style> elements)', () => {
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
  })

  it('lets images come from the app, data: and the screenshot scheme only', () => {
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'redlog-screenshot:'])
  })

  it('reaches no network origin from the renderer (it fetches nothing; everything is IPC)', () => {
    expect(csp.get('connect-src')).toEqual(["'self'"])
    for (const [name, sources] of csp) {
      for (const s of sources) expect(s, name).not.toMatch(/^(https?|wss?):|localhost|\*|'unsafe-eval'/)
    }
  })

  it('denies plugins, <base>, framing and form posts', () => {
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'none'"])
    expect(csp.get('frame-ancestors')).toEqual(["'none'"])
    expect(csp.get('form-action')).toEqual(["'none'"])
  })
})

// Anything in a page the production script-src ('self' only) would refuse.
function blockedByScriptSrc(html: string): string[] {
  const problems: string[] = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1]
    if (!src) problems.push(`inline <script>: ${m[2].trim().slice(0, 40)}`)
    else if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) problems.push(`script from another origin: ${src}`)
  }
  for (const m of html.matchAll(/<[^>]+\s(on[a-z]+)\s*=/gi)) problems.push(`inline handler ${m[1]}`)
  if (/javascript:/i.test(html)) problems.push('javascript: URL')
  return problems
}

describe('renderer html against the production script-src', () => {
  it('the check itself catches what the policy blocks', () => {
    expect(blockedByScriptSrc('<script>alert(1)</script><img onerror="x"><script src="https://cdn.example/x.js"></script>')).toEqual([
      'inline <script>: alert(1)', 'script from another origin: https://cdn.example/x.js', 'inline handler onerror'
    ])
    expect(blockedByScriptSrc('<script type="module" crossorigin src="./assets/main.js"></script>')).toEqual([])
  })

  const root = path.resolve(__dirname, '..')
  const pages = ['index.html', 'overlay.html']
  it.each(pages)('src/renderer/%s', (page) => {
    expect(blockedByScriptSrc(fs.readFileSync(path.join(root, 'src/renderer', page), 'utf8'))).toEqual([])
  })

  // CI's unit leg runs before `npm run build`, so the built pages are checked
  // where a build exists (locally, and wherever this runs after one).
  const built = path.join(root, 'out/renderer')
  it.skipIf(!fs.existsSync(path.join(built, 'index.html'))).each(pages)('out/renderer/%s', (page) => {
    expect(blockedByScriptSrc(fs.readFileSync(path.join(built, page), 'utf8'))).toEqual([])
  })

  it.skipIf(!fs.existsSync(path.join(built, 'assets')))('no built renderer chunk needs unsafe-eval', () => {
    const chunks = fs.readdirSync(path.join(built, 'assets')).filter((f) => f.endsWith('.js'))
    expect(chunks.length).toBeGreaterThan(0)
    const evaling = chunks.filter((f) => /new Function\(|[^\w.$]eval\(/.test(fs.readFileSync(path.join(built, 'assets', f), 'utf8')))
    expect(evaling).toEqual([])
  })
})

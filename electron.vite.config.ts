import { resolve } from 'path'
import { readFileSync } from 'fs'
import { execFileSync } from 'node:child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { buildVariantFromEnv, VARIANT_FILE } from './scripts/build-variant.mjs'

// release unless REDLOG_SMOKE_BUILD=1 is set for this build (scripts/build-variant.mjs).
// One value feeds both the main bundle's define and the file the release
// verifier reads back out of the package, so the two cannot disagree.
const buildVariant = buildVariantFromEnv(process.env)
const writeBuildVariant = {
  name: 'redlog:build-variant',
  generateBundle(this: { emitFile: (file: { type: 'asset'; fileName: string; source: string }) => string }) {
    this.emitFile({ type: 'asset', fileName: VARIANT_FILE.replace(/^out\/main\//, ''), source: `${JSON.stringify({ variant: buildVariant })}\n` })
  }
}

const pkgVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version
const buildId = (() => {
  try {
    const options = { cwd: __dirname, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] }
    const commit = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], options).trim()
    const changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], options).trim()
    return `${commit}${changed ? '+local' : ''}`
  } catch { return 'unknown' }
})()


// @fontsource ships every face twice: woff2 first, woff as a fallback for
// browsers from before 2018. Electron is Chromium, which has supported woff2
// since 36, so the fallback is never requested — it is 5.4 MB of installer
// weight for a code path that cannot execute. Strip the second `src` entry
// before Vite resolves the url() and the file is never emitted.
const dropLegacyWoff = {
  name: 'redlog:drop-legacy-woff',
  // Ahead of vite:css, which resolves url() into emitted assets.
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('@fontsource') || !id.endsWith('.css')) return null
    const out = code.replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, '')
    return out === code ? null : { code: out, map: null }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), writeBuildVariant],
    define: { __APP_VERSION__: JSON.stringify(pkgVersion), __REDLOG_SMOKE_BUILD__: JSON.stringify(buildVariant === 'smoke') },
    // Rolldown (Vite 8) only emits "use strict" in CommonJS output when the
    // source has it, and the TypeScript sources do not; Rollup always did.
    build: { rollupOptions: { output: { strict: true } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts')
        },
        output: { strict: true }
      }
    }
  },
  renderer: {
    plugins: [react(), dropLegacyWoff],
    define: { __APP_VERSION__: JSON.stringify(pkgVersion), __APP_BUILD__: JSON.stringify(buildId) },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
        },
        output: {
          manualChunks(id) {
            if (id.includes('@xterm/xterm') || id.includes('@xterm/')) return 'vendor-xterm'
            if (id.includes('@fontsource/')) return 'vendor-fonts'
            if (id.includes('@tanstack/react-virtual')) return 'vendor-virtual'
          }
        }
      }
    }
  }
})

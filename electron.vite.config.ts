import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const pkgVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version

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
    plugins: [externalizeDepsPlugin()],
    define: { __APP_VERSION__: JSON.stringify(pkgVersion) }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react(), dropLegacyWoff],
    define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
        }
      }
    }
  }
})

import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const pkgVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version

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
    plugins: [react()],
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

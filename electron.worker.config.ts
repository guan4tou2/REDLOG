import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version) },
    build: {
      emptyOutDir: false,
      rollupOptions: { input: { 'export-worker': resolve('src/main/services/export-worker.ts') } }
    }
  }
})

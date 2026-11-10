import { build } from 'electron-vite'
import { resolve } from 'node:path'
import { access } from 'node:fs/promises'

await build({ configFile: resolve('electron.worker.config.ts') })
await access(resolve('out/main/export-worker.js'))

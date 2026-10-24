// Build each optional package independently. Nothing imports these entrypoints
// into Electron's main bundle, and discovery reads only their manifests.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { build } from 'vite'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'optional-plugins')
const output = path.join(root, 'out', 'optional-ai')
fs.mkdirSync(output, { recursive: true })
const names = fs.readdirSync(source).filter(name => fs.existsSync(path.join(source, name, 'plugin.json')))
for (const stale of fs.readdirSync(output)) if (!names.includes(stale)) fs.rmSync(path.join(output, stale), { recursive: true, force: true })
for (const name of names) {
  const dir = path.join(output, name)
  await build({
    configFile: false, logLevel: 'error',
    build: { ssr: true, target: 'node22', outDir: dir, emptyOutDir: true, minify: false,
      rollupOptions: { input: path.join(source, name, 'adapter.ts'), external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
        output: { format: 'cjs', entryFileNames: 'adapter.cjs', inlineDynamicImports: true } } },
    ssr: { noExternal: true }
  })
  const manifest = JSON.parse(fs.readFileSync(path.join(source, name, 'plugin.json'), 'utf8'))
  manifest.redlogAgent.sha256 = createHash('sha256').update(fs.readFileSync(path.join(dir, 'adapter.cjs'))).digest('hex')
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
}
console.log(`Built ${names.length} optional AI packages`)

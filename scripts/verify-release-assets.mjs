#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, createReadStream } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${version}`) {
  throw new Error(`Tag ${process.env.RELEASE_TAG} does not match package ${version}`)
}
const files = new Map()
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else {
      if (files.has(entry.name)) throw new Error(`Duplicate release asset: ${entry.name}`)
      files.set(entry.name, path)
    }
  }
}
walk(process.argv[2] ?? 'artifacts')
const installer = `RedLog.Setup.${version}.exe`
const required = [installer, `RedLog-${version}-arm64.dmg`, `RedLog-${version}-arm64-mac.zip`, `redlog_${version}_amd64.deb`]
for (const name of [...required, 'latest.yml']) {
  if (!files.has(name)) throw new Error(`Missing release asset: ${name}`)
  if (statSync(files.get(name)).size === 0) throw new Error(`Empty release asset: ${name}`)
}
for (const name of files.keys()) {
  if (/\.(exe|dmg|zip|deb|AppImage)$/i.test(name) && !required.includes(name)) {
    throw new Error(`Unexpected release package: ${name}`)
  }
}
const update = yaml.load(readFileSync(files.get('latest.yml'), 'utf8'))
const entries = update?.files
if (update?.version !== version || update?.path !== installer || !Array.isArray(entries) || entries.length !== 1) {
  throw new Error('Windows update metadata does not match this release')
}
const entry = entries[0]
if (entry.url !== installer || basename(entry.url) !== installer || entry.size !== statSync(files.get(installer)).size) {
  throw new Error('Windows update installer name/size does not match')
}
const digest = createHash('sha512')
for await (const chunk of createReadStream(files.get(installer))) digest.update(chunk)
const sha512 = digest.digest('base64')
if (entry.sha512 !== sha512 || update.sha512 !== sha512) throw new Error('Windows update installer SHA-512 does not match')
console.log(`Release ${version}: all three platforms, supplementary Mac ZIP and Windows update metadata verified`)

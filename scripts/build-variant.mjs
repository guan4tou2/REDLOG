// The two package variants, decided at BUILD time and never at run time.
//
//   release  the default for every build that does not opt out. The Node
//            inspector fuse is off, a packaged launch drops the remote
//            debugging switches, and REDLOG_E2E* are inert.
//   smoke    REDLOG_SMOKE_BUILD=1 at `npm run build`, plus SMOKE_FUSE_OVERRIDES
//            at electron-builder. Only the install-smoke workflows build it:
//            Playwright launches the installed app with --inspect=0 and
//            --remote-debugging-port=0 and drives it through REDLOG_E2E.
//
// electron.vite.config.ts compiles the variant into the main bundle and writes
// VARIANT_FILE beside it; verify-packaged-resources.mjs reads that file back
// out of the package and checks it against the fuses.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

export const SMOKE_BUILD_ENV = 'REDLOG_SMOKE_BUILD'
/** Inside app.asar (electron-builder packs out/**). */
export const VARIANT_FILE = 'out/main/build-variant.json'
/** What the smoke variant changes in electron-builder.yml's electronFuses. */
export const SMOKE_FUSE_OVERRIDES = Object.freeze({ enableNodeCliInspectArguments: true })
export const VARIANTS = Object.freeze(['release', 'smoke'])

/** The variant a build run with this environment produces. */
export function buildVariantFromEnv(env) {
  return env[SMOKE_BUILD_ENV] === '1' ? 'smoke' : 'release'
}

/** Parses the content of VARIANT_FILE. Throws on anything but a known variant. */
export function parseVariantFile(text) {
  let variant
  try { variant = JSON.parse(text)?.variant } catch { /* reported below */ }
  if (!VARIANTS.includes(variant)) throw new Error(`${VARIANT_FILE} does not name a build variant: ${String(text).slice(0, 80)}`)
  return variant
}

/** The variant a packaged app's main bundle was built as, from its Resources dir. */
export function readPackagedVariant(resourcesRoot) {
  const archive = path.join(resourcesRoot, 'app.asar')
  let text
  if (fs.existsSync(archive)) {
    // A dependency of electron-builder (app-builder-lib), present wherever a package is built.
    const asar = createRequire(import.meta.url)('@electron/asar')
    try { text = asar.extractFile(archive, VARIANT_FILE).toString('utf8') } catch {
      throw new Error(`${VARIANT_FILE} is not in ${archive}; the package was not built by this electron.vite.config.ts`)
    }
  } else {
    const loose = path.join(resourcesRoot, 'app', VARIANT_FILE)
    if (!fs.existsSync(loose)) throw new Error(`No app.asar and no ${loose}`)
    text = fs.readFileSync(loose, 'utf8')
  }
  return parseVariantFile(text)
}

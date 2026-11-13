// Where the offline verifier that every evidence bundle carries is read from.
// A function of the code's own directory only, so the layouts can be tested
// without moving the module.

import fs from 'fs'
import path from 'path'

const VERIFIER = path.join('tools', 'redlog-verify.py')

/** The places tried, in order, for code located at `dirname`.
 *
 *  - Packaged: the code runs from <resources>/app.asar/out/main and
 *    electron-builder's `extraResources` puts the verifier at
 *    <resources>/tools/redlog-verify.py (app.asar holds only out/ and
 *    resources/).
 *  - A checkout: src/core (a source run) and out/main (electron-vite, the
 *    built export worker) are both two levels below it.
 *
 *  Never a directory above the checkout, and never the working directory:
 *  either can hold some other verifier, and whatever is found here is shipped
 *  inside the evidence bundle as the one to check it with. */
function bundleVerifierCandidates(dirname: string): string[] {
  const asar = dirname.search(/[\\/]app\.asar(?=[\\/]|$)/)
  if (asar >= 0) return [path.join(dirname.slice(0, asar), VERIFIER)]
  return [path.join(dirname, '..', '..', VERIFIER)]
}

/** The verifier to copy into a bundle. Throws, naming every place tried, when
 *  there is none: this bundle is sold as "with verifier", so a build that lost
 *  the file (it was once not packaged at all) must fail loudly rather than ship
 *  a bundle a recipient cannot check. */
export function findBundleVerifier(dirname: string): string {
  const candidates = bundleVerifierCandidates(dirname)
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) {
    throw new Error(`Evidence bundle verifier not found — this RedLog build is missing tools/redlog-verify.py. Tried: ${candidates.join(', ')}`)
  }
  return found
}

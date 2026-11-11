import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { ExportTask, ExportTaskResult } from '../../core/export-task'

export type ExportTaskRunner = (task: ExportTask, isAllowed?: (completed?: boolean) => boolean) => Promise<ExportTaskResult>

/** Only plan metadata crosses back into main. Payloads and expensive bundle/HAR
 * work stay in a read-only worker; unpublished outputs belong to one private
 * staging directory until the main thread rechecks current project/policy. */
export const runExportTask: ExportTaskRunner = async (input, isAllowed = () => true) => {
  const outDir = input.kind === 'plan' || input.kind === 'validate' || input.kind === 'logged-digest' ? null
    : input.kind === 'bundle' || input.kind === 'direct-bundle' ? input.options.outRoot : input.outDir
  let stagedFd: number | undefined
  let stage: string | undefined
  let identity: fs.BigIntStats | undefined
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true })
    stage = fs.mkdtempSync(path.join(outDir, '.redlog-export-'))
    fs.chmodSync(stage, 0o700)
    identity = fs.lstatSync(stage, { bigint: true })
  }
  const ownedStage = () => {
    if (!stage || !identity) return false
    try {
      const now = fs.lstatSync(stage, { bigint: true })
      return now.isDirectory() && now.dev === identity.dev && now.ino === identity.ino
    } catch { return false }
  }
  // The staged file is opened here, not in the worker, so that terminating a
  // worker mid-write cannot leave a descriptor behind: it is closed in `finally`.
  const stagedEventFile = () => {
    const file = path.join(stage!, 'events.part')
    stagedFd = fs.openSync(file, 'wx', 0o600)
    return { file, fd: stagedFd }
  }
  const entry = path.join(__dirname, 'export-worker.js')
  // Source tests use the production worker built by pretest; packaged code is
  // emitted beside it. No TypeScript loader or test-only execution branch.
  const workerFile = fs.existsSync(entry) ? entry : path.resolve(__dirname, '../../../out/main/export-worker.js')
  let worker: Worker | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    if (!isAllowed()) throw new Error('project-changed')
    const task: ExportTask = input.kind === 'bundle' || input.kind === 'direct-bundle' ? { ...input, options: { ...input.options, outRoot: stage } }
      : input.kind === 'har' ? { ...input, outDir: stage! }
      : input.kind === 'events' ? { ...input, outDir: stage!, ...stagedEventFile() } : input
    worker = new Worker(workerFile, { workerData: task })
    const reply = await new Promise<ExportTaskResult>((resolve, reject) => {
      let settled = false
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error) } }
      worker!.once('error', fail)
      worker!.once('exit', code => fail(new Error(`Export worker exited before delivery (${code})`)))
      worker!.once('message', (message: { result?: ExportTaskResult; error?: string }) => {
        if (settled) return
        settled = true
        if (message.error || !message.result) reject(new Error(message.error ?? 'Invalid export worker result'))
        else resolve(message.result)
      })
      timer = setInterval(() => {
        try { if (!isAllowed()) fail(new Error('project-changed')) } catch (error) { fail(error as Error) }
      }, 25)
    })
    if (!isAllowed(true)) throw new Error('project-changed')
    if ('plan' in reply || 'validation' in reply || 'loggedDigest' in reply) return reply
    if (!stage || !outDir || !ownedStage()) throw new Error('Export staging directory changed')
    const artifact = path.resolve(reply.artifactPath)
    const relative = path.relative(stage, artifact)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(artifact).isSymbolicLink()) throw new Error('Invalid export artifact path')
    if (input.kind === 'events') {
      // Same names the in-process writer used: second-resolution timestamp, a
      // numeric suffix on collision, and never a name an earlier export's
      // manifest already claims.
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      for (let suffix = 1; ; suffix++) {
        const file = path.join(outDir, `redlog-${timestamp}${suffix === 1 ? '' : '-' + suffix}.${input.format}`)
        if (fs.existsSync(file + '.manifest.json')) continue
        try { fs.linkSync(artifact, file) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error }
        fs.unlinkSync(artifact)
        return { artifactPath: file }
      }
    }
    if (input.kind === 'direct-bundle') {
      // The name the in-process API export gives: bundle-<ts>, then -2, -3 …
      const base = path.join(outDir, path.basename(artifact))
      let target = base
      for (let suffix = 2; fs.existsSync(target); suffix++) target = `${base}-${suffix}`
      fs.renameSync(artifact, target)
      return { artifactPath: target }
    }
    const target = path.join(outDir, `${path.parse(artifact).name}-${randomUUID()}${path.extname(artifact)}`)
    if (fs.lstatSync(artifact).isDirectory()) fs.renameSync(artifact, target)
    else { fs.linkSync(artifact, target); fs.unlinkSync(artifact) }
    return { artifactPath: target }
  } finally {
    if (timer) clearInterval(timer)
    await worker?.terminate()
    if (stagedFd !== undefined) try { fs.closeSync(stagedFd) } catch { /* already closed */ }
    if (ownedStage()) fs.rmSync(stage!, { recursive: true, force: true })
  }
}

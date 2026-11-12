import { parentPort, workerData, receiveMessageOnPort, type MessagePort } from 'node:worker_threads'
import { openReadonlyProjectDB, closeDB, getDB } from '../../core/db/index'
import { executeExportTask, type ExportTask } from '../../core/export-task'
import type { SealWriter } from '../../core/bundle-export'

const { task, sealPort, sealSignal } = workerData as { task: ExportTask; sealPort: MessagePort; sealSignal: SharedArrayBuffer }

/** A bundle's seal is a chained row, and only main writes the chain. The
 *  bundle build is synchronous, so the request blocks here until main has
 *  inserted the row and posted it back (export-runner.ts). */
const sealWriter: SealWriter = (engagementId, data) => {
  const signal = new Int32Array(sealSignal)
  Atomics.store(signal, 0, 0)
  parentPort!.postMessage({ seal: { engagementId, data } })
  // Main answers within one event-loop turn; the bound only stops a lost
  // answer from hanging the export forever.
  if (Atomics.wait(signal, 0, 0, 60_000) === 'timed-out') throw new Error('Export seal was not answered')
  const reply = receiveMessageOnPort(sealPort)?.message as { row?: Record<string, unknown>; error?: string } | undefined
  if (!reply?.row) throw new Error(reply?.error ?? 'Export seal was not recorded')
  return reply.row
}

try {
  openReadonlyProjectDB(task.project.path, task.project.id)
  getDB().exec('BEGIN')
  try { parentPort!.postMessage({ result: executeExportTask(task, { sealWriter }) }) }
  finally { getDB().exec('ROLLBACK') }
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) })
} finally { closeDB(); sealPort.close() }

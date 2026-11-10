import { parentPort, workerData } from 'node:worker_threads'
import { openReadonlyProjectDB, closeDB, getDB } from '../../core/db/index'
import { executeExportTask, type ExportTask } from '../../core/export-task'

const task = workerData as ExportTask
try {
  openReadonlyProjectDB(task.project.path, task.project.id)
  getDB().exec('BEGIN')
  try { parentPort!.postMessage({ result: executeExportTask(task) }) }
  finally { getDB().exec('ROLLBACK') }
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) })
} finally { closeDB() }

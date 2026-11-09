import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { eventsToNdjson } from './ndjson-export'
import { operatorPiiReplacements } from './operator-pii'
import type { RedLogEvent } from './db/events'

// Serialization and file writes run off the UI's main thread. Acknowledged
// batches bound the worker queue even when the filesystem is slow.
const source = `
const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs');
const replacements=workerData.replacements.map(([pattern,flags,value])=>[new RegExp(pattern,flags),value]);
const ndjson=(${eventsToNdjson.toString()});
let count=0;
const scrub=text=>{for(const [re,value] of replacements)text=text.replace(re,value);return text};
const write=text=>{const buffer=Buffer.from(scrub(text));let offset=0;while(offset<buffer.length)offset+=fs.writeSync(workerData.fd,buffer,offset,buffer.length-offset)};
const metadata=workerData.metadata;
let suffix='';
if(workerData.format==='json'){
 const document=JSON.stringify({config:metadata.config,events:[],exportedAt:metadata.exportedAt,exportPlan:metadata.exportPlan},null,2);
 const index=document.lastIndexOf('"events": []')+'"events": '.length;
 write(document.slice(0,index));suffix=document.slice(index+2);
}
parentPort.on('message',message=>{
 try{
  if(message.rows){
   for(const event of message.rows){
    if(workerData.format==='ndjson')write(ndjson([event],{alreadyRedacted:true}));
    else {write((count?',\\n':'[\\n')+JSON.stringify(event,null,2).split('\\n').map(line=>'    '+line).join('\\n'));}
    count++;
   }
   parentPort.postMessage({ready:true});
  }else if(message.end){
   if(workerData.format==='json')write((count?'\\n  ]':'[]')+suffix);
   fs.fsyncSync(workerData.fd);parentPort.postMessage({done:true});
  }
 }catch(error){parentPort.postMessage({error:error.message});}
});
parentPort.postMessage({ready:true});
`

export async function writeApprovedEventExport(
  outDir: string, format: 'json' | 'ndjson', events: readonly RedLogEvent[],
  metadata: { config: unknown; exportedAt: string; exportPlan: { id: string; fingerprint: string } } | null,
  scrubPii: boolean, isAllowed: (completed?: boolean) => boolean
): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let file = '', fd: number | undefined
  for (let suffix = 1; fd === undefined; suffix++) {
    file = path.join(outDir, `redlog-${timestamp}${suffix === 1 ? '' : '-' + suffix}.${format}`)
    if (fs.existsSync(file + '.manifest.json')) continue
    try { fd = fs.openSync(file, 'wx', 0o600) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  const identity = fs.fstatSync(fd, { bigint: true })
  const ownsDestination = () => {
    const named = fs.lstatSync(file, { bigint: true })
    return named.isFile() && named.ino === identity.ino && named.dev === identity.dev
  }
  let worker: Worker | undefined
  let closed = false
  try {
    const replacements = scrubPii ? operatorPiiReplacements().map(([re, value]) => [re.source, re.flags, value]) : []
    worker = new Worker(source, { eval: true, workerData: { fd, format, metadata, replacements } })
    const response = () => new Promise<{ error?: string; done?: boolean }>((resolve, reject) => {
      const cleanup = () => {
        worker!.off('message', message)
        worker!.off('error', failed)
        worker!.off('exit', exited)
      }
      const failed = (error: Error) => { cleanup(); reject(error) }
      const exited = (code: number) => failed(new Error(`Export worker exited before delivery (${code})`))
      const message = (reply: { error?: string; done?: boolean }) => {
        cleanup()
        try {
          if (reply.error) throw new Error(reply.error)
          if (!isAllowed(reply.done === true)) throw new Error('project-changed')
          resolve(reply)
        } catch (error) { reject(error) }
      }
      worker!.once('message', message)
      worker!.once('error', failed)
      worker!.once('exit', exited)
    })
    await response()
    for (let offset = 0; offset < events.length; offset += 16) {
      const ready = response()
      worker.postMessage({ rows: events.slice(offset, offset + 16) })
      await ready
    }
    const done = response()
    worker.postMessage({ end: true })
    await done
    fs.closeSync(fd)
    closed = true
    if (!ownsDestination()) throw new Error('Export destination changed')
    return file
  } catch (error) {
    await worker?.terminate()
    if (!closed) try { fs.closeSync(fd) } catch { /* worker may already have closed it */ }
    if (ownsDestination()) fs.unlinkSync(file)
    throw error
  } finally { await worker?.terminate() }
}

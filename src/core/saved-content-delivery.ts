import fs from 'node:fs'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { getProjectDir } from './db/index'
import { readEventContent } from './evidence-content'
import { ContentAccessError } from './body-source'
import { isInsideDir } from './paths'
import type { ContentRef, ContentResult } from './content-contract'

/** A local saved representation, not a scope-sanitized evidence bundle.
 * Never overwrite files; incomplete writes are removed and never reported saved. */
export async function saveEventContent(ref:ContentRef,destination:string,isAllowed:()=>boolean):Promise<ContentResult<{path:string;bytes:number}>> {
  let fd:number|undefined,created:fs.BigIntStats|undefined
  try{
    if(!isAllowed())throw new ContentAccessError('denied','Content project changed')
    const parent=fs.realpathSync(path.dirname(destination))
    if(isInsideDir(fs.realpathSync(getProjectDir()),path.join(parent,path.basename(destination))))throw new ContentAccessError('denied','project-destination')
    let offset=0,total:number|undefined
    do{
      if(!isAllowed())throw new ContentAccessError('denied','Content project changed')
      const reply=readEventContent({ref,offset})
      if(!reply.ok)throw new ContentAccessError(reply.status,reply.message)
      const part=reply.value
      const bytes=Buffer.from(part.text,part.format==='binary'?'base64':'utf8')
      if(part.offset!==offset||bytes.length!==part.end-offset||total!=null&&total!==part.total)throw new ContentAccessError('changed','Saved content range changed')
      total=part.total
      if(fd===undefined){fd=fs.openSync(destination,'wx',0o600);created=fs.fstatSync(fd,{bigint:true})}
      let written=0
      while(written<bytes.length){const count=fs.writeSync(fd,bytes,written,bytes.length-written);if(!count)throw new Error('Content file write did not advance');written+=count}
      if(part.hasMore&&part.end<=offset)throw new ContentAccessError('failed','Content cursor did not advance')
      offset=part.end
      await setImmediate()
    }while(offset<total!)
    if(!isAllowed())throw new ContentAccessError('denied','Content project changed')
    const checked=readEventContent({ref,offset,limit:4})
    if(!checked.ok)throw new ContentAccessError(checked.status,checked.message)
    const named=fs.lstatSync(destination,{bigint:true})
    if(named.isSymbolicLink()||named.dev!==created!.dev||named.ino!==created!.ino)throw new ContentAccessError('changed','Destination changed while saving')
    fs.fsyncSync(fd!)
    fs.closeSync(fd!);fd=undefined
    return {ok:true,value:{path:destination,bytes:offset}}
  }catch(error){
    if(fd!==undefined)try{fs.closeSync(fd)}catch{/* preserve the delivery failure */}
    if(created)try{const named=fs.lstatSync(destination,{bigint:true});if(!named.isSymbolicLink()&&named.dev===created.dev&&named.ino===created.ino)fs.unlinkSync(destination)}catch{/* leave the original failure visible */}
    return {ok:false,status:error instanceof ContentAccessError?error.status:'failed',message:(error as NodeJS.ErrnoException).code==='EEXIST'?'destination-exists':error instanceof Error?error.message:String(error)}
  }
}

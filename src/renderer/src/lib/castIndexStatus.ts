import type { ReadState } from './readState'

// What the search panel may claim about terminal-recording completeness.
//
// Four answers, because there are four situations and only one of them
// licenses "nothing more to find":
//   ready    the index answered: every recording is read.
//   pending  the index answered: some recordings are not read yet.
//   unknown  it has not answered yet.
//   failed   it was asked and did not answer, or answered nonsense.
// An empty output search is only authoritative under `ready`.

export type IndexStatus =
  | { kind: 'ready' }
  | { kind: 'pending'; pending: number }
  | { kind: 'unknown' }
  | { kind: 'failed'; error: string | null }
  | { kind:'partial';pending:number;failed:number;unsupported:number;unavailable:number }

export function indexStatusOf(read: ReadState<{ pending: number;failed?:number;unsupported?:number;unavailable?:number }>): IndexStatus {
  // A failure wins over a stale value: "ready" a minute ago is not "ready".
  if (read.phase === 'failed') return { kind: 'failed', error: read.error }
  if (read.phase === 'loading') return { kind: 'unknown' }
  const pending = (read.value as { pending?: unknown } | null)?.pending
  if (typeof pending !== 'number' || !Number.isFinite(pending) || pending < 0) {
    return { kind: 'failed', error: null }
  }
  const {failed=0,unsupported=0,unavailable=0}=read.value!
  if([failed,unsupported,unavailable].some(n=>!Number.isSafeInteger(n)||n<0))return {kind:'failed',error:null}
  if(failed||unsupported||unavailable)return {kind:'partial',pending,failed,unsupported,unavailable}
  return pending > 0 ? { kind: 'pending', pending } : { kind: 'ready' }
}

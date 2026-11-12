import { toast } from '../components/Toast'

export type MutationResult<T> = { ok: true; value: T } | { ok: false }

/**
 * Run an operator-visible write and say so when it did not land. A rejection
 * is a failure, and so is a `null` or `false` reply unless `isFailure` says
 * otherwise (a reply of `null` is how main refuses a write with no active
 * project). The caller keeps whatever the operator typed and only moves on
 * when `ok` is true. The error toast persists until dismissed.
 */
export async function runMutation<T>(
  call: () => Promise<T>,
  opts: { failed: string; why?: string; isFailure?: (v: T) => boolean }
): Promise<MutationResult<T>> {
  try {
    const value = await call()
    if (opts.isFailure ? opts.isFailure(value) : value == null || value === false) {
      toast(opts.failed, { type: 'error', why: opts.why })
      return { ok: false }
    }
    return { ok: true, value }
  } catch (e) {
    toast(opts.failed, { type: 'error', why: opts.why, detail: e instanceof Error ? e.message : String(e) })
    return { ok: false }
  }
}

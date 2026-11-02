/**
 * One open project, as the main process sees it: which open a piece of async
 * work belongs to, and a stop that reaches everything that open started.
 *
 * Before this, an open was a set of module variables in main/index.ts. A
 * timer, a `.then` after the login PATH, a cast backfill and a scope
 * recompute each decided for themselves whether their project was still the
 * open one — by project id, which cannot tell the first A of A → B → A from
 * the second, or not at all. The recompute did not ask, and wrote the first
 * project's re-judgement into the second project's chain.
 *
 * A `ProjectContext` is handed to work when it starts. `signal` aborts the
 * moment its open stops; `isCurrent` answers for code that cannot take a
 * signal. Timers and cleanups registered against a context are the runtime's
 * to stop, newest first, and every one runs even when an earlier one throws.
 *
 * Switching is not a transaction: the old open stops, then the new one
 * begins. A failed open is cleaned up and reported; it does not bring the old
 * project back. docs/DESIGN-project-runtime.md.
 */

import type { ProjectMeta } from './project-manager'

export type ProjectRuntimeState = 'closed' | 'opening' | 'active' | 'closing' | 'failed'

export interface ProjectIdentity {
  projectId: string
  engagementId: string
  operatorId: string
}

/** The project and engagement are fixed for the life of an open. The
 *  operator is not: Settings can change it while the project stays open, and
 *  `setOperator` makes every holder of the context see it from the next read.
 *  Read the identity when writing, not once at start. */
export interface ProjectContext extends Readonly<ProjectIdentity> {
  readonly generation: number
  readonly signal: AbortSignal
}

interface Open {
  context: ProjectContext
  /** Replaced, never mutated: a rename makes a new one. */
  project: Readonly<ProjectMeta>
  controller: AbortController
  cleanups: Array<() => unknown>
  activated: boolean
  operatorId: string
}

export class ProjectRuntime {
  private generation = 0
  private open: Open | null = null
  private status: ProjectRuntimeState = 'closed'

  get state(): ProjectRuntimeState { return this.status }

  current(): ProjectContext | null { return this.open?.context ?? null }

  /** The open project, from `begin` until `close` starts. Null while closing:
   *  an open that is being taken down is no longer the one to act on. */
  project(): Readonly<ProjectMeta> | null {
    return this.open && this.status !== 'closing' ? this.open.project : null
  }

  isCurrent(context: ProjectContext): boolean {
    return this.open?.context === context && !context.signal.aborted
  }

  /** Start a new open. The previous one must already be closed: the caller
   *  owns the order of a switch, and stopping it here would hide that. */
  begin(project: ProjectMeta, ids: Omit<ProjectIdentity, 'projectId'>): ProjectContext {
    if (this.open) throw new Error(`project runtime: generation ${this.open.context.generation} is still ${this.status}`)
    const controller = new AbortController()
    const open: Open = {
      context: null!, project: Object.freeze({ ...project }), controller, cleanups: [], activated: false, operatorId: ids.operatorId
    }
    open.context = Object.freeze({
      projectId: project.id,
      engagementId: ids.engagementId,
      get operatorId() { return open.operatorId },
      generation: ++this.generation,
      signal: controller.signal
    })
    this.open = open
    this.status = 'opening'
    return open.context
  }

  /** Change the operator of the live open. An open that has ended keeps the
   *  operator it ended with: its late writes are refused by engagement, and
   *  must not be relabelled. */
  setOperator(context: ProjectContext, operatorId: string): boolean {
    if (!this.isCurrent(context)) return false
    this.open!.operatorId = operatorId
    return true
  }

  /** A rename of the open project. The open goes on: same generation, same
   *  signal, same identity. Only the name a reader sees changes. */
  renameProject(context: ProjectContext, name: string): boolean {
    if (!this.isCurrent(context)) return false
    this.open!.project = Object.freeze({ ...this.open!.project, name })
    return true
  }

  activate(context: ProjectContext): void {
    if (!this.isCurrent(context)) throw new Error(`project runtime: generation ${context.generation} is not the open project`)
    this.open!.activated = true
    this.status = 'active'
  }

  /** Run `cleanup` when this open stops. Against an open that has already
   *  stopped it runs now: the stop it was waiting for has happened. */
  onStop(context: ProjectContext, cleanup: () => unknown): void {
    if (!this.isCurrent(context)) { cleanup(); return }
    this.open!.cleanups.push(cleanup)
  }

  setInterval(context: ProjectContext, tick: () => void, ms: number): void {
    if (!this.isCurrent(context)) return
    const timer = setInterval(() => { if (this.isCurrent(context)) tick() }, ms)
    this.open!.cleanups.push(() => clearInterval(timer))
  }

  setTimeout(context: ProjectContext, fire: () => void, ms: number): void {
    if (!this.isCurrent(context)) return
    const timer = setTimeout(() => { if (this.isCurrent(context)) fire() }, ms)
    this.open!.cleanups.push(() => clearTimeout(timer))
  }

  /** Abort the open's signal, then run its cleanups newest first. Every one
   *  runs; the first failure is rethrown after the last. An open that never
   *  reached `active` ends `failed`. */
  close(): void {
    const open = this.open
    if (!open) return
    this.status = 'closing'
    open.controller.abort()
    let failed = false
    let firstError: unknown
    for (const cleanup of open.cleanups.reverse()) {
      try { cleanup() } catch (error) {
        if (!failed) { failed = true; firstError = error }
      }
    }
    this.open = null
    this.status = open.activated ? 'closed' : 'failed'
    if (failed) throw firstError
  }
}

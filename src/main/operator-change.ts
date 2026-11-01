import type { ProjectContext, ProjectRuntime } from '../core/project-runtime'

interface Operator { id: string; name: string }

/** The two places that stamp captures with an identity and do not hold the
 *  open's context: the file the shell hooks and HTTP addon read, and the
 *  API's primary operator, who a request with the project token is. */
export interface OperatorSinks {
  writeSpoolIdentity: (context: ProjectContext) => void
  /** False, with nothing changed, when the id cannot become primary. */
  setPrimaryOperator: (id: string, name: string) => boolean
}

/** Settings saved while the project is open. An operator change takes effect
 *  for every source at once: the sources in the app read it from the context,
 *  and the two outside it are told here. Events already spooled keep the
 *  operator they were captured under.
 *
 *  Returns the operator now in effect, for the caller to save. A blank id is
 *  not an operator: every capture would be refused unrecorded, so the old id
 *  stays. The API goes first because it is the one that can say no, and the
 *  others must not move to an operator it refused. */
export function applyOperatorChange(runtime: ProjectRuntime, context: ProjectContext,
  before: Operator, after: Operator, sinks: OperatorSinks): Operator {
  const next = after.id.trim() ? { id: after.id.trim(), name: after.name } : { id: before.id, name: after.name }
  if (!runtime.isCurrent(context)) return next
  if (next.id === before.id && next.name === before.name) return next
  if (!sinks.setPrimaryOperator(next.id, next.name)) return before
  if (next.id !== context.operatorId) {
    runtime.setOperator(context, next.id)
    sinks.writeSpoolIdentity(context)
  }
  return next
}

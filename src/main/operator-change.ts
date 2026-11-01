import type { ProjectContext, ProjectRuntime } from '../core/project-runtime'

interface Operator { id: string; name: string }

/** The two places that stamp captures with an identity and do not hold the
 *  open's context: the file the shell hooks and HTTP addon read, and the
 *  API's primary operator, who a request with the project token is. */
export interface OperatorSinks {
  writeSpoolIdentity: (context: ProjectContext) => void
  setPrimaryOperator: (id: string, name: string) => void
}

/** Settings saved while the project is open. An operator change takes effect
 *  for every source at once: the sources in the app read it from the context,
 *  and the two outside it are told here. Events already spooled keep the
 *  operator they were captured under. */
export function applyOperatorChange(runtime: ProjectRuntime, context: ProjectContext,
  before: Operator, after: Operator, sinks: OperatorSinks): void {
  if (!runtime.isCurrent(context)) return
  if (after.id === before.id && after.name === before.name) return
  if (after.id !== context.operatorId) {
    runtime.setOperator(context, after.id)
    sinks.writeSpoolIdentity(context)
  }
  sinks.setPrimaryOperator(after.id, after.name)
}

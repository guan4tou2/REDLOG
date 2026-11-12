export type BuildVariant = 'release' | 'smoke'
export const SMOKE_BUILD_ENV: 'REDLOG_SMOKE_BUILD'
export const VARIANT_FILE: string
export const SMOKE_FUSE_OVERRIDES: Readonly<{ enableNodeCliInspectArguments: true }>
export const VARIANTS: readonly BuildVariant[]
export function buildVariantFromEnv(env: Record<string, string | undefined>): BuildVariant
export function parseVariantFile(text: string): BuildVariant
export function readPackagedVariant(resourcesRoot: string): BuildVariant

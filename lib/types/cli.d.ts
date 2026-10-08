/**
 * Public types for the command-line surface.
 */

import type { SyncPlan } from './sync-core.js'

/** Parsed command-line options. */
export interface CliOptions {
  readonly from: readonly string[] | undefined
  readonly to: readonly string[] | undefined
  readonly dshHome: string | undefined
  readonly all: boolean
  readonly prune: boolean
  readonly allowConflicts: boolean
  readonly apply: boolean
  readonly install: boolean
  readonly backup: boolean
  readonly check: boolean
  readonly json: boolean
  readonly help: boolean
}

/** Injectable IO, so the CLI can be driven from tests. */
export interface CliIo {
  readonly env?: NodeJS.ProcessEnv
  readonly stdout?: (text: string) => void
  readonly stderr?: (text: string) => void
}

/** Parse argv into options, throwing on an unknown or malformed flag. */
export declare function parseArgs(argv: readonly string[]): CliOptions

/** Resolve the effective source and target profile sets. */
export declare function resolveProfileSets(
  options: CliOptions,
  dshHome: string,
): { sources: string[]; targets: string[] }

/** Run the CLI. @returns the process exit code. */
export declare function main(argv: readonly string[], io?: CliIo): Promise<number>

/** Render the plan as a human-readable report. */
export declare function renderPlan(plan: SyncPlan): string

/** Render one apply event as a single line. */
export declare function renderEvent(event: { type: string } & Record<string, unknown>): string

/** Render the apply result summary. */
export declare function renderResult(result: {
  results: ReadonlyArray<{ name: string; status: string; changes: readonly string[]; installed: boolean; error?: string; verification?: { aligned: boolean; missingBundles: readonly string[]; missingPackages: readonly string[] } }>
}): string

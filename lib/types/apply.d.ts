/**
 * Public types for the side-effecting half of cross-profile plugin sync.
 */

import type { SyncPlan, TargetVerification } from './sync-core.js'

/** How the package manager is started. */
export interface PnpmInvocation {
  /** Executable name or absolute path. */
  readonly command: string
  /** Arguments placed before `install`. */
  readonly prefixArgs: readonly string[]
  /** Human-readable name used in messages. */
  readonly label: string
}

/** A resolved candidate that may or may not exist on this host. */
export interface ResolvedInvocation {
  /** Absolute executable path, or undefined when nothing matched. */
  readonly executable: string | undefined
  readonly prefixArgs: readonly string[]
  readonly label: string
}

/** Progress events emitted while applying a plan. */
export interface ApplyEvent {
  readonly type: string
  readonly target?: string
  readonly changes?: readonly string[]
  readonly backup?: string
  readonly error?: string
  readonly code?: number | null
  readonly reason?: string
  readonly label?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly dir?: string
  readonly missingBundles?: readonly string[]
  readonly missingDependencies?: readonly string[]
  readonly missingPackages?: readonly string[]
}

/** The outcome for one target profile. */
export interface ApplyTargetResult {
  readonly name: string
  readonly status: 'aligned' | 'missing' | 'write-failed' | 'applied' | 'applied-install-failed'
  readonly changes: readonly string[]
  readonly installed: boolean
  readonly verification?: TargetVerification
  readonly installSkipped?: string
  readonly backup?: string
  readonly error?: string
}

/** The complete result of one apply. */
export interface ApplyResult {
  readonly dshHome: string
  readonly results: readonly ApplyTargetResult[]
  /** Whether any manifest was replaced. */
  readonly wroteAny: boolean
}

/** Options accepted by {@link applySync}. */
export interface ApplyOptions {
  /** Run the package manager after writing (default true). */
  readonly install?: boolean
  readonly onEvent?: (event: ApplyEvent) => void
  /** Keep a `.bak` beside each edited manifest (default true). */
  readonly backup?: boolean
  /** Re-read each target after applying (default true). */
  readonly verify?: boolean
  readonly pnpm?: PnpmInvocation
  readonly signal?: AbortSignal
  readonly now?: () => string
}

/** The spawn target for one command. */
export interface SpawnTarget {
  readonly file: string
  readonly args: readonly string[]
  /** True only for a Windows command script, which cannot be spawned directly. */
  readonly shell: boolean
}

/** Apply a computed plan. */
export declare function applySync(plan: SyncPlan, options?: ApplyOptions): Promise<ApplyResult>

/** @returns the ordered package-manager candidates. */
export declare function pnpmInvocationCandidates(): readonly PnpmInvocation[]

/** Resolve a candidate to an executable that exists on this host. */
export declare function resolveInvocation(candidate: PnpmInvocation): ResolvedInvocation

/** @returns an absolute executable path, or undefined when nothing matched. */
export declare function resolveExecutable(command: string): string | undefined

/** Build the spawn target, enabling a shell only for a command script. */
export declare function spawnTarget(command: string, args: readonly string[]): SpawnTarget

/** Run `install` in a profile directory. */
export declare function runPnpmInstall(
  profileDir: string,
  options?: {
    pnpm?: PnpmInvocation
    signal?: AbortSignal
    onEvent?: (event: ApplyEvent) => void
  },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; label: string }>

/** @returns true when the profile directory already has an installed tree. */
export declare function hasInstalledTree(profileDir: string): boolean

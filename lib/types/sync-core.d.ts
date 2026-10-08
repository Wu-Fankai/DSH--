/**
 * Public types for the pure planning and manifest-editing core.
 *
 * Nothing here boots DSH, spawns a process, or touches the network: every
 * function takes explicit paths so the algorithm can be tested against a
 * temporary directory.
 */

/** Product bundles shipped by a profile template, which are never synced. */
export declare const PRODUCT_BUNDLES: readonly string[]

/** Bundle names owned by the DSH Desktop launcher, which are never synced. */
export declare const DESKTOP_OWNED_BUNDLES: readonly string[]

/** Manifest key recording which bundles this tool has synced. */
export declare const SYNC_LEDGER_KEY: 'profileSyncLedger'

/** How one declared bundle was classified. */
export type BundleKind = 'product' | 'desktop-owned' | 'user' | 'unknown'

/** One bundle declared by a profile, with its classification. */
export interface BundleRecord {
  /** Bundle package name. */
  readonly name: string
  /**
   * `user` is the only kind that is ever synced. `unknown` means the manifest
   * selected a bundle without declaring where it comes from.
   */
  readonly kind: BundleKind
  /** Dependency specifier when the manifest declares one. */
  readonly spec?: string
  /** Whether a package manifest exists in the profile's `node_modules`. */
  readonly installed: boolean
}

/** One loaded profile manifest. */
export interface ProfileRecord {
  /** Profile name. */
  readonly name: string
  /** Absolute profile directory. */
  readonly dir: string
  /** Absolute path of the profile manifest. */
  readonly manifestPath: string
  /** Always true for a loaded profile. */
  readonly exists: true
  /** Whether DSH Desktop owns this profile name. */
  readonly reserved: boolean
  /** Declared dependency specifiers. */
  readonly dependencies: Readonly<Record<string, string>>
  /** Classified bundles in composition order. */
  readonly bundles: readonly BundleRecord[]
  /** Bundle names in composition order. */
  readonly bundleNames: readonly string[]
  /** Bundle names this tool has synced into this profile before. */
  readonly syncLedger: readonly string[]
  /** The parsed manifest, kept for structural edits. */
  readonly raw: Record<string, unknown>
}

/** One planned edit to a target profile. */
export interface TargetStep {
  readonly name: string
  readonly spec: string
  /** Source profile that contributed the specifier, or null for a removal. */
  readonly from: string | null
  readonly action: 'add' | 'remove'
  readonly installRequired: boolean
}

/** The plan for one target profile. */
export interface TargetPlan {
  readonly name: string
  readonly dir: string
  /** Whether DSH Desktop owns the name, so the CLI refuses to manage it. */
  readonly reserved: boolean
  readonly steps: readonly TargetStep[]
  /** Whether the target already satisfies the plan. */
  readonly aligned: boolean
  readonly sources: readonly string[]
}

/** A bundle declared with different specifiers by different sources. */
export interface SpecConflict {
  readonly name: string
  readonly specs: ReadonlyArray<{ readonly from: string; readonly spec: string }>
}

/** The complete cross-profile plan. */
export interface SyncPlan {
  readonly dshHome: string
  /** Source profiles that actually exist. */
  readonly sources: readonly string[]
  /** The union of syncable user bundles. */
  readonly candidates: ReadonlyArray<{ readonly name: string; readonly spec: string; readonly from: string }>
  /** Bundles the sources declare differently. */
  readonly conflicts: readonly SpecConflict[]
  /** Candidates whose specifier resolves relative to the source profile. */
  readonly localSpecs: ReadonlyArray<{ readonly name: string; readonly spec: string; readonly from: string }>
  readonly targets: readonly TargetPlan[]
  /** Bundles deliberately not synced, with the reason. */
  readonly skipped: ReadonlyArray<{ readonly profile: string; readonly name: string; readonly reason: string }>
  readonly missingSources: readonly string[]
  readonly missingTargets: readonly string[]
  readonly prune: boolean
  /** Whether conflicting sources were refused rather than resolved. */
  readonly strict: boolean
  /** Whether applying this plan would change anything. */
  readonly restartRequired: boolean
}

/** Verification of one target against a plan. */
export interface TargetVerification {
  /** Whether the manifest declares everything the plan asked for. */
  readonly aligned: boolean
  /** How many user bundles the profile declares; 0 means it wants nothing. */
  readonly declared: number
  /** Whether every declared bundle is present in `node_modules`. */
  readonly installed: boolean
  readonly missingBundles: readonly string[]
  readonly missingDependencies: readonly string[]
  readonly missingPackages: readonly string[]
}

/** Profile-level verification, independent of any plan. */
export interface ProfileVerification {
  /** Whether the profile has a manifest at all. */
  readonly present: boolean
  /** Every bundle the manifest classifies as a user bundle. */
  readonly declared: readonly string[]
  /** Declared bundles with no package in `node_modules`. */
  readonly missingPackages: readonly string[]
}

/** Inputs accepted by {@link planSync}. */
export interface PlanOptions {
  readonly dshHome: string
  readonly sources: readonly string[]
  readonly targets: readonly string[]
  readonly prune?: boolean
  /** Refuse when sources disagree instead of taking the first specifier. */
  readonly strict?: boolean
}

/** @returns true when the bundle belongs to the DSH installation. */
export declare function isProductBundle(name: string): boolean

/** @returns true when the bundle is owned by the DSH Desktop launcher. */
export declare function isDesktopOwnedBundle(name: string): boolean

/** @returns true when the name is safe to write into a manifest. */
export declare function isSafePackageName(value: unknown): value is string

/** @returns true when the name is safe to use as one directory segment. */
export declare function isSafeProfileName(value: unknown): value is string

/** @returns true when the specifier points at local storage rather than a registry. */
export declare function isLocalSpecifier(spec: string): boolean

/** @returns the immutable product bundle list. */
export declare function productBundles(): readonly string[]

/** @returns the absolute DSH home the launcher would use. */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv): string

/** @returns the absolute directory backing one profile. */
export declare function profileDirectory(dshHome: string, name: string): string

/** @returns true when DSH Desktop owns this profile name. */
export declare function isReservedProfileName(name: string): boolean

/** @returns sorted names of profiles that have a manifest. */
export declare function listProfiles(dshHome: string): string[]

/** @returns the loaded profile, or undefined when it has no manifest. */
export declare function loadProfile(dshHome: string, name: string): ProfileRecord | undefined

/** @returns the syncable bundles a profile could contribute. */
export declare function syncableBundles(profile: ProfileRecord): Array<{ name: string; spec: string }>

/** @returns the union of user bundles across sources, plus any conflicts. */
export declare function collectCandidates(sources: readonly ProfileRecord[]): {
  candidates: Array<{ name: string; spec: string; from: string }>
  conflicts: SpecConflict[]
}

/** Compute the plan without writing anything. */
export declare function planSync(options: PlanOptions): SyncPlan

/** Render the exact manifest text an apply would write, without writing it. */
export declare function renderNextManifest(
  profile: ProfileRecord,
  targetPlan: TargetPlan,
  recordedAt: string,
): { text: string; raw: Record<string, unknown>; changes: string[] }

/** @returns bundle names the plan adds that are absent from `node_modules`. */
export declare function missingInstalls(profile: ProfileRecord, targetPlan: TargetPlan): string[]

/** Verify one whole profile, independent of any plan. */
export declare function verifyProfile(dshHome: string, name: string): ProfileVerification

/** Verify a target on disk against the plan that was applied. */
export declare function verifyTarget(dshHome: string, targetPlan: TargetPlan): TargetVerification

/** Acquire the exclusive advisory lock beside a manifest. */
export declare function acquireManifestLock(
  manifestPath: string,
  options?: { timeoutMs?: number; staleMs?: number; now?: () => number },
): () => void

/** Replace a manifest atomically, optionally keeping a backup. */
export declare function writeManifestAtomic(
  manifestPath: string,
  text: string,
  options?: { backup?: boolean },
): string | undefined

/** Validate an absolute path, throwing a message an operator can act on. */
export declare function requireAbsolutePath(label: string, value: string): string

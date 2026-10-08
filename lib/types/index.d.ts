/**
 * Public types for the DSH host face of cross-profile plugin sync.
 *
 * The plugin publishes a capability on the Host context. The name is namespaced
 * because `ctx.provide` throws on a duplicate, and a generic word is far more
 * likely to be claimed by another plugin.
 */

import type { ApplyResult } from './apply.js'
import type { SyncPlan } from './sync-core.js'

/** Stable Cordis plugin name; also the settings namespace of this row. */
export declare const name: 'dsh-plugin-profile-sync'

/** Context property this plugin publishes. */
export declare const SERVICE_NAME: 'dshProfileSync'

/** Services awaited before the capability is published. */
export declare const inject: readonly string[]

/** This plugin's Loader row configuration. */
export interface SyncConfig {
  /** Source profiles; `sources` is an alias. */
  readonly from?: string | readonly string[]
  /** Target profiles; `targets` is an alias. */
  readonly to?: string | readonly string[]
  readonly sources?: string | readonly string[]
  readonly targets?: string | readonly string[]
  /** Explicit DSH home; defaults to `$DSH_HOME` or `~/.dsh`. */
  readonly dshHome?: string
}

/** Explicit profile sets for one call. */
export interface SyncOverride {
  readonly sources?: readonly string[]
  readonly targets?: readonly string[]
  readonly prune?: boolean
}

/** The capability published as `ctx.dshProfileSync`. */
export interface ProfileSyncService {
  /** @returns sorted names of profiles that have a manifest. */
  listProfiles(): string[]
  /** Compute a plan without writing anything. */
  plan(override?: SyncOverride): SyncPlan
  /** Compute and apply the plan. */
  sync(override?: SyncOverride & { install?: boolean }): Promise<ApplyResult>
}

/** Normalize one configured profile set. */
export declare function configuredProfiles(value: unknown): string[] | undefined

/** Narrow a launcher-published profile fact. */
export declare function launchedProfile(value: unknown): { name: string; dir: string } | undefined

/** Resolve the source and target profile sets for this generation. */
export declare function resolveProfiles(
  ctx: object,
  config?: SyncConfig,
): { sources: string[]; targets: string[]; dshHome: string; origin: string } | { error: string }

/** Build the service object without touching its context beyond reads. */
export declare function createProfileSyncService(ctx: object, config?: SyncConfig): ProfileSyncService

/** Publish the capability on this Host context. */
export declare function apply(ctx: object, config?: SyncConfig): void

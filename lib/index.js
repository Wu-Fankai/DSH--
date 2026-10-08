/**
 * DSH host face of cross-Profile plugin sync.
 *
 * The plugin publishes `ctx.profileSync` for other Host plugins, and it takes
 * its target profiles from one of two places, in this order:
 *
 *  1. `config` from this plugin's Loader row in `cordis.patch.yml` — an
 *     operator statement, so it always wins.
 *  2. The launcher's own answer, when `profileContext` is available.
 *
 * A plugin must never infer the active profile from `process.argv` or
 * `$DSH_HOME` when the launcher will tell it, and it must never guess: when
 * neither source is available the service stays inert and every call that
 * needs a profile refuses until the caller names one explicitly.
 */

import { applySync } from './apply.js'
import {
  listProfiles,
  planSync,
  resolveDshHome,
  requireAbsolutePath,
} from './sync-core.js'

/** Stable Cordis plugin name; also the settings namespace of this row. */
export const name = 'dsh-plugin-profile-sync'

/**
 * Context property this plugin publishes.
 *
 * Namespaced rather than a bare `profileSync` because `ctx.provide` throws on a
 * duplicate name, and a generic word is far more likely to be claimed by another
 * plugin than one carrying this package's own prefix.
 */
export const SERVICE_NAME = 'dshProfileSync'

/**
 * Services awaited before the profile capability is published.
 *
 * `webServer` is a stable Host service in every web-shaped profile, so it is a
 * safe readiness gate: the profile is composed before this capability can
 * mutate another profile's manifest.
 */
export const inject = ['webServer']

/**
 * Read one context service without letting a failure escape.
 *
 * `ctx.get()` is total for a registered service, but a service whose own
 * constructor throws would propagate here, and an optional probe must degrade
 * to "unknown" rather than break this plugin's boot.
 * @param {object} ctx - Cordis host context.
 * @param {string} serviceName - service to read.
 * @returns {unknown} the service value, or undefined.
 */
function probeService(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/**
 * Narrow a launcher-published profile fact.
 * @param {unknown} value - candidate `profileContext` service.
 * @returns {{name: string, dir: string} | undefined} the narrowed fact.
 */
export function launchedProfile(value) {
  if (value === null || typeof value !== 'object') return undefined
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const dir = typeof value.dir === 'string' ? value.dir.trim() : ''
  if (name === '' || dir === '') return undefined
  return { name, dir }
}

/**
 * Normalize one configured profile set.
 * @param {unknown} value - configured value.
 * @returns {string[] | undefined} normalized names, or undefined when unset.
 */
export function configuredProfiles(value) {
  if (value === undefined) return undefined
  const list = Array.isArray(value) ? value : [value]
  const names = list
    .filter(entry => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
  return names.length === 0 ? undefined : names
}

/**
 * Resolve the DSH home this generation should edit.
 * @param {SyncConfig} config - this row's configuration.
 * @returns {{dshHome: string} | {error: string}} resolution or a refusal.
 */
function resolveHome(config) {
  if (config.dshHome === undefined) {
    try {
      return { dshHome: resolveDshHome() }
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) }
    }
  }
  try {
    return { dshHome: requireAbsolutePath('config.dshHome', config.dshHome) }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Resolve the source and target profile sets for this generation.
 * @param {object} ctx - Cordis host context.
 * @param {SyncConfig} [config] - this row's configuration.
 * @returns {{sources: string[], targets: string[], dshHome: string, origin: string} | {error: string}} resolution or a refusal.
 */
export function resolveProfiles(ctx, config = {}) {
  const configuredSources = configuredProfiles(config.from ?? config.sources)
  const configuredTargets = configuredProfiles(config.to ?? config.targets)
  const launched = launchedProfile(probeService(ctx, 'profileContext'))
  const home = resolveHome(config)
  if ('error' in home) return home

  let sources = configuredSources
  let targets = configuredTargets
  let origin = 'default'
  if (configuredSources !== undefined) {
    origin = 'config'
  } else if (launched !== undefined) {
    sources = [launched.name]
    origin = 'profileContext'
  }
  if (sources === undefined) {
    return {
      error: 'profile-sync: no source profile is configured and the launcher published none; '
        + 'set `from`/`to` on this plugin\'s row, or pass --from/--to to the CLI',
    }
  }

  if (targets === undefined) {
    const discovered = listProfiles(home.dshHome)
    if (launched !== undefined && !discovered.includes(launched.name)) {
      return {
        error: `profile-sync: the launcher reported profile ${JSON.stringify(launched.name)} at ${launched.dir}, `
          + `but only ${discovered.join(', ') || '(none)'} exist under ${home.dshHome}; set \`from\`/\`to\` explicitly`,
      }
    }
    targets = discovered.filter(profile => !sources.includes(profile))
    if (targets.length === 0) {
      return {
        error: `profile-sync: no target profile found under ${home.dshHome} besides ${sources.join(', ')}`,
      }
    }
  }
  return { sources, targets, dshHome: home.dshHome, origin }
}

/**
 * Publish the profile-sync capability on this Host context.
 *
 * The publication is capability-probed: a Host whose Cordis build has no
 * `provide` still gets the CLI and the module exports, and only loses the
 * cross-plugin service.
 * @param {object} ctx - Cordis host context.
 * @param {SyncConfig} [config] - this plugin's row configuration.
 */
export function apply(ctx, config = {}) {
  const service = createProfileSyncService(ctx, config)
  const logger = ctx.logger ?? console
  if (typeof ctx.provide === 'function') {
    try {
      // `provide` registers its own fiber effect internally and returns the
      // disposer, so wrapping it in another `ctx.effect()` would only add a
      // layer that can never be reached.
      ctx.provide(SERVICE_NAME, service)
      logger.info?.(`dsh-plugin-profile-sync: published ctx.${SERVICE_NAME}`)
      return
    } catch (cause) {
      // A duplicate service name throws synchronously. A capability this plugin
      // can live without must never be why a profile fails to boot.
      logger.warn?.(
        `dsh-plugin-profile-sync: could not publish ctx.${SERVICE_NAME} `
        + `(${cause instanceof Error ? cause.message : String(cause)}); the CLI remains available`,
      )
    }
  }
  // Exposing the object on the context keeps a Host plugin that already holds
  // this ctx able to call it when service registration is unavailable.
  ctx[SERVICE_NAME] = service
  logger.info?.(`dsh-plugin-profile-sync: exposed ctx.${SERVICE_NAME} without service registration`)
}

/**
 * Build the service object without touching its context beyond reads.
 * @param {object} ctx - Cordis host context.
 * @param {SyncConfig} [config] - this plugin's row configuration.
 * @returns {ProfileSyncService} the service.
 */
export function createProfileSyncService(ctx, config = {}) {
  return {
    /**
     * Discover which profiles have a manifest.
     * @returns {string[]} sorted profile names.
     */
    listProfiles() {
      return listProfiles(resolveOrThrow(ctx, config, {}).dshHome)
    },
    /**
     * Compute the plan without writing anything.
     * @param {SyncOverride} [override] - explicit profile sets.
     * @returns {import('./sync-core.js').SyncPlan} the plan.
     */
    plan(override = {}) {
      const resolved = resolveOrThrow(ctx, config, override)
      return planSync({
        dshHome: resolved.dshHome,
        sources: override.sources ?? resolved.sources,
        targets: override.targets ?? resolved.targets,
        prune: override.prune === true,
      })
    },
    /**
     * Compute and apply the plan.
     * @param {SyncOverride & {install?: boolean}} [override] - explicit profile sets and install control.
     * @returns {Promise<import('./apply.js').ApplyResult>} per-target outcomes.
     */
    async sync(override = {}) {
      const resolved = resolveOrThrow(ctx, config, override)
      const plan = planSync({
        dshHome: resolved.dshHome,
        sources: override.sources ?? resolved.sources,
        targets: override.targets ?? resolved.targets,
        prune: override.prune === true,
      })
      const logger = ctx.logger ?? console
      logger.info?.(
        `dsh-plugin-profile-sync: ${plan.sources.join(', ')} -> ${plan.targets.map(target => target.name).join(', ')} `
        + `(${String(plan.candidates.length)} candidate bundle(s))`,
      )
      const result = await applySync(plan, { install: override.install !== false })
      for (const entry of result.results) {
        if (entry.error !== undefined) {
          logger.error?.(`dsh-plugin-profile-sync: ${entry.name}: ${entry.error}`)
        } else if (entry.status === 'applied') {
          logger.info?.(`dsh-plugin-profile-sync: ${entry.name}: applied ${String(entry.changes.length)} change(s)`)
        }
      }
      return result
    },
  }
}

/**
 * Resolve profile sets or throw a message an operator can act on.
 * @param {object} ctx - Cordis host context.
 * @param {SyncConfig} config - row configuration.
 * @param {SyncOverride} override - explicit sets.
 * @returns {{sources: string[], targets: string[], dshHome: string}} resolved sets.
 */
function resolveOrThrow(ctx, config, override) {
  const resolved = resolveProfiles(ctx, config)
  if ('error' in resolved) throw new Error(resolved.error)
  return {
    sources: override.sources ?? resolved.sources,
    targets: override.targets ?? resolved.targets,
    dshHome: resolved.dshHome,
  }
}

/**
 * @typedef {object} SyncConfig
 * @property {string | string[]} [from] - source profiles.
 * @property {string | string[]} [to] - target profiles.
 * @property {string | string[]} [sources] - alias of `from`.
 * @property {string | string[]} [targets] - alias of `to`.
 * @property {string} [dshHome] - explicit DSH home.
 */

/**
 * @typedef {object} SyncOverride
 * @property {string[]} [sources] - source profiles.
 * @property {string[]} [targets] - target profiles.
 * @property {boolean} [prune] - plan removals as well.
 */

/**
 * @typedef {object} ProfileSyncService
 * @property {() => string[]} listProfiles - discover profiles with a manifest.
 * @property {(override?: SyncOverride) => import('./sync-core.js').SyncPlan} plan - compute a plan.
 * @property {(override?: SyncOverride & {install?: boolean}) => Promise<import('./apply.js').ApplyResult>} sync - compute and apply.
 */

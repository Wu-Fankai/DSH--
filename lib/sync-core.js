/**
 * Pure planning and manifest-editing core for cross-Profile plugin sync.
 *
 * Nothing in this file boots DSH, spawns a process, or touches the network:
 * every function takes explicit paths so the whole algorithm is unit-testable
 * against a temporary directory. `lib/apply.js` owns the side effects.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Product bundles that belong to the DSH installation rather than to the user.
 *
 * These are shipped by a profile template (or by DSH Desktop) and are
 * deliberately NOT synced: the desktop profile composes a different product
 * bundle set than the web profile, and copying one into the other is how a
 * profile is bricked. Local (`web`/`desktop`) and 0.1.7-era names are both
 * listed because the same plugin must work across DSH releases.
 */
export const PRODUCT_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-desktop-app',
  '@deepseek-ai/dsh-tui-app',
])

const PRODUCT_BUNDLE_SET = new Set(PRODUCT_BUNDLES)

/**
 * Bundle names owned by DSH Desktop's launcher rather than by the user.
 *
 * A profile that composes the desktop shell must keep composing it; syncing it
 * into a non-Desktop profile would demand a launcher service that a plain
 * `dsh web` boot does not provide.
 */
export const DESKTOP_OWNED_BUNDLES = Object.freeze([
  'dsh-plugin-desktop',
  'dsh-community-market',
])

const DESKTOP_OWNED_BUNDLE_SET = new Set(DESKTOP_OWNED_BUNDLES)

/** Ledger key DSH Desktop keeps for bundles its recovery UI deselected. */
const DESELECTED_BUNDLES_KEY = 'desktopDeselectedBundles'

/** Package-name grammar accepted by DSH Desktop's own manifest reader. */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/** Profile names DSH Desktop or the CLI reserve. */
const RESERVED_PROFILE_NAMES = new Set(['desktop'])

/** Maximum manifest size accepted, mirroring DSH Desktop's 1 MiB bound. */
const MAX_MANIFEST_BYTES = 1024 * 1024

/** Marker written into a manifest to record this tool's own edits. */
export const SYNC_LEDGER_KEY = 'profileSyncLedger'

/**
 * Bundle names the user could have installed, cached from DSH Desktop's own
 * source so the two agree instead of drifting.
 * @returns {readonly string[]} immutable bundle names.
 */
export function productBundles() {
  return PRODUCT_BUNDLES
}

/**
 * Whether a manifest bundle belongs to the DSH installation.
 * @param {string} name - bundle package name.
 * @returns {boolean} true when the bundle must never be synced.
 */
export function isProductBundle(name) {
  return PRODUCT_BUNDLE_SET.has(name)
}

/**
 * Whether a bundle is owned by the DSH Desktop launcher.
 * @param {string} name - bundle package name.
 * @returns {boolean} true when the bundle is Desktop-owned.
 */
export function isDesktopOwnedBundle(name) {
  return DESKTOP_OWNED_BUNDLE_SET.has(name)
}

/**
 * Whether a package name is safe to put in a manifest.
 * @param {unknown} value - candidate name.
 * @returns {boolean} true when the name matches the accepted grammar.
 */
export function isSafePackageName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 214
    && PACKAGE_NAME_PATTERN.test(value)
}

/**
 * Whether a profile name is safe to use as one directory segment.
 * @param {unknown} value - candidate profile name.
 * @returns {boolean} true when the name is a safe single segment.
 */
export function isSafeProfileName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0')
}

/**
 * Resolve the DSH home directory the same way the launcher does.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute DSH home directory.
 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') {
    return resolve(configured.trim())
  }
  const home = env.USERPROFILE ?? env.HOME
  if (typeof home !== 'string' || home.trim() === '') {
    throw new Error('profile-sync: cannot determine DSH home; set DSH_HOME')
  }
  return join(resolve(home.trim()), '.dsh')
}

/**
 * Absolute directory backing one profile.
 * @param {string} dshHome - absolute DSH home.
 * @param {string} name - profile name.
 * @returns {string} absolute profile directory.
 */
export function profileDirectory(dshHome, name) {
  if (!isSafeProfileName(name)) {
    throw new Error(`profile-sync: invalid profile name ${JSON.stringify(name)}`)
  }
  return join(resolve(dshHome), 'profiles', name)
}

/**
 * Whether DSH Desktop owns this profile name.
 * @param {string} name - profile name.
 * @returns {boolean} true when the name is reserved.
 */
export function isReservedProfileName(name) {
  return RESERVED_PROFILE_NAMES.has(name)
}

/**
 * Read one profile manifest without interpreting it.
 * @param {string} dir - absolute profile directory.
 * @returns {{raw: Record<string, unknown>, bytes: number} | undefined} parsed manifest, or undefined when absent.
 */
function readManifestFile(dir) {
  const path = join(dir, 'package.json')
  let info
  try {
    info = lstatSync(path)
  } catch (cause) {
    if (cause.code === 'ENOENT') return undefined
    throw cause
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`profile-sync: ${path} must be a regular file`)
  }
  if (info.size > MAX_MANIFEST_BYTES) {
    throw new Error(`profile-sync: ${path} exceeds ${String(MAX_MANIFEST_BYTES)} bytes`)
  }
  const text = readFileSync(path, 'utf8')
  let raw
  try {
    // A UTF-8 BOM is tolerated rather than rejected: Windows editors and
    // PowerShell's `Set-Content -Encoding utf8` add one, and DSH Desktop's own
    // manifest reader accepts it, so refusing here would disagree with the
    // application about which profiles are readable at all.
    raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
  } catch (cause) {
    throw new Error(`profile-sync: ${path} is not valid JSON: ${cause.message}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`profile-sync: ${path} must contain a JSON object`)
  }
  return { raw, bytes: info.size }
}

/**
 * Normalize the `dependencies` object of a manifest.
 * @param {Record<string, unknown>} raw - parsed manifest.
 * @param {string} label - profile name used in error messages.
 * @returns {Record<string, string>} dependency specifiers, or an empty object.
 */
function readDependencies(raw, label) {
  const dependencies = raw.dependencies
  if (dependencies === undefined) return {}
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error(`profile-sync: profile ${JSON.stringify(label)} dependencies must be an object`)
  }
  const result = {}
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!isSafePackageName(name)) {
      throw new Error(`profile-sync: profile ${JSON.stringify(label)} declares an invalid dependency name ${JSON.stringify(name)}`)
    }
    if (typeof spec !== 'string' || spec.trim() === '') {
      throw new Error(`profile-sync: profile ${JSON.stringify(label)} dependency ${JSON.stringify(name)} must have a string specifier`)
    }
    result[name] = spec
  }
  return result
}

/**
 * Normalize the `dsh.profile` section of a manifest.
 * @param {Record<string, unknown>} raw - parsed manifest.
 * @param {string} label - profile name used in error messages.
 * @returns {{bundles: string[], patchReload?: string}} declared bundle list.
 */
function readProfileSection(raw, label) {
  const dsh = raw.dsh
  if (dsh === undefined) return { bundles: [] }
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) {
    throw new Error(`profile-sync: profile ${JSON.stringify(label)} dsh field must be an object`)
  }
  const profile = dsh.profile
  if (profile === undefined) return { bundles: [] }
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`profile-sync: profile ${JSON.stringify(label)} dsh.profile field must be an object`)
  }
  const bundles = profile.bundles
  if (bundles === undefined) return { bundles: [] }
  if (!Array.isArray(bundles) || bundles.some(name => !isSafePackageName(name))) {
    throw new Error(`profile-sync: profile ${JSON.stringify(label)} dsh.profile.bundles must be an array of package names`)
  }
  const duplicates = bundles.filter((name, index) => bundles.indexOf(name) !== index)
  if (duplicates.length > 0) {
    throw new Error(`profile-sync: profile ${JSON.stringify(label)} dsh.profile.bundles repeats ${JSON.stringify(duplicates[0])}`)
  }
  return {
    bundles: [...bundles],
    ...(typeof profile.patchReload === 'string' ? { patchReload: profile.patchReload } : {}),
  }
}

/**
 * Whether a bundle is physically installed in a profile's `node_modules`.
 * @param {string} dir - absolute profile directory.
 * @param {string} packageName - bundle package name.
 * @returns {boolean} true when a package manifest exists for it.
 */
function isPhysicallyInstalled(dir, packageName) {
  const path = join(dir, 'node_modules', ...packageName.split('/'), 'package.json')
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Load one profile, classifying every declared bundle.
 * @param {string} dshHome - absolute DSH home.
 * @param {string} name - profile name.
 * @returns {ProfileRecord | undefined} the loaded profile, or undefined when it has no manifest.
 */
export function loadProfile(dshHome, name) {
  const dir = profileDirectory(dshHome, name)
  const file = readManifestFile(dir)
  if (file === undefined) return undefined
  const { raw } = file
  const dependencies = readDependencies(raw, name)
  const section = readProfileSection(raw, name)
  const bundles = section.bundles.map(bundle => {
    const product = isProductBundle(bundle)
    const desktopOwned = isDesktopOwnedBundle(bundle)
    const declared = Object.hasOwn(dependencies, bundle)
    const installed = isPhysicallyInstalled(dir, bundle)
    // A bundle is only user data when the manifest both selects it and declares
    // where it comes from. A bare name in `bundles` is not enough to copy: with
    // no specifier there is nothing to install on the other side, so it is
    // reported as unknown and left alone rather than guessed at.
    let kind
    if (product) kind = 'product'
    else if (desktopOwned) kind = 'desktop-owned'
    else if (declared) kind = 'user'
    else kind = 'unknown'
    return {
      name: bundle,
      kind,
      spec: dependencies[bundle],
      installed,
    }
  })
  const ledger = Array.isArray(raw[SYNC_LEDGER_KEY])
    ? raw[SYNC_LEDGER_KEY].filter(entry => typeof entry === 'string')
    : []
  return {
    name,
    dir,
    manifestPath: join(dir, 'package.json'),
    exists: true,
    reserved: isReservedProfileName(name),
    dependencies,
    bundles,
    bundleNames: bundles.map(bundle => bundle.name),
    syncLedger: ledger,
    raw,
  }
}

/**
 * List profile names that have a manifest on disk.
 * @param {string} dshHome - absolute DSH home.
 * @returns {string[]} sorted profile names.
 */
export function listProfiles(dshHome) {
  const profilesRoot = join(resolve(dshHome), 'profiles')
  if (!existsSync(profilesRoot)) return []
  const names = []
  const entries = readdirSafe(profilesRoot)
  for (const entry of entries) {
    if (!isSafeProfileName(entry)) continue
    const dir = join(profilesRoot, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (existsSync(join(dir, 'package.json'))) names.push(entry)
  }
  return names.sort()
}

/**
 * Read directory entries without failing on a missing directory.
 * @param {string} path - directory to read.
 * @returns {string[]} entry names.
 */
function readdirSafe(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Bundles a profile could contribute to another profile.
 *
 * Only `user` kind passes: product bundles, Desktop-owned bundles, and bundles
 * with no dependency specifier are never candidates.
 * @param {ProfileRecord} profile - loaded profile.
 * @returns {Array<{name: string, spec: string}>} syncable bundles.
 */
export function syncableBundles(profile) {
  const result = []
  for (const bundle of profile.bundles) {
    if (bundle.kind !== 'user') continue
    result.push({ name: bundle.name, spec: bundle.spec })
  }
  return result
}

/**
 * Collect the union of user-installed bundles across the source profiles.
 * @param {ProfileRecord[]} sources - loaded source profiles.
 * @returns {{candidates: Array<{name: string, spec: string, from: string}>, conflicts: Array<{name: string, specs: Array<{from: string, spec: string}>}>}} candidates and spec conflicts.
 */
export function collectCandidates(sources) {
  const byName = new Map()
  for (const profile of sources) {
    for (const bundle of syncableBundles(profile)) {
      const existing = byName.get(bundle.name)
      if (existing === undefined) {
        byName.set(bundle.name, [{ from: profile.name, spec: bundle.spec }])
      } else {
        existing.push({ from: profile.name, spec: bundle.spec })
      }
    }
  }
  const candidates = []
  const conflicts = []
  for (const name of [...byName.keys()].sort()) {
    const origins = byName.get(name)
    const specs = [...new Set(origins.map(origin => origin.spec))]
    if (specs.length > 1) {
      conflicts.push({ name, specs: origins.map(origin => ({ ...origin })) })
    }
    // The first source that declares the bundle owns the specifier, so the
    // result does not depend on which profiles happened to be scanned.
    candidates.push({ name, spec: origins[0].spec, from: origins[0].from })
  }
  return { candidates, conflicts }
}

/**
 * Compute the cross-profile sync plan.
 *
 * The plan is a pure data structure: `applyPlan` is the only function that
 * writes anything, so `--dry-run` and `--apply` cannot diverge in reasoning.
 * @param {object} options - planning inputs.
 * @param {string} options.dshHome - absolute DSH home.
 * @param {string[]} options.sources - profile names to collect from.
 * @param {string[]} options.targets - profile names to align.
 * @param {boolean} [options.prune] - also remove user bundles the sources lack.
 * @param {boolean} [options.strict] - refuse rather than warn when sources disagree.
 * @returns {SyncPlan} the plan.
 */
export function planSync(options) {
  const { dshHome } = options
  const sourceNames = [...new Set(options.sources)]
  const targetNames = [...new Set(options.targets)]
  if (sourceNames.length === 0) throw new Error('profile-sync: at least one source profile is required')
  if (targetNames.length === 0) throw new Error('profile-sync: at least one target profile is required')

  const missingSources = []
  const sources = []
  for (const name of sourceNames) {
    const profile = loadProfile(dshHome, name)
    if (profile === undefined) {
      missingSources.push(name)
      continue
    }
    sources.push(profile)
  }
  if (sources.length === 0) {
    throw new Error(`profile-sync: none of the source profiles exist (${sourceNames.join(', ')})`)
  }

  const { candidates, conflicts } = collectCandidates(sources)
  const sourceNames0 = sources.map(profile => profile.name)
  // A source that declares a bundle two ways is an ambiguity, not a preference:
  // picking one silently is how a target ends up with a version nobody chose.
  if (options.strict === true && conflicts.length > 0) {
    const detail = conflicts
      .map(conflict => `${conflict.name} (${conflict.specs.map(pair => `${pair.spec} from ${pair.from}`).join(' vs ')})`)
      .join('; ')
    throw new Error(
      `profile-sync: sources disagree on ${String(conflicts.length)} bundle(s): ${detail}; `
      + 'align the sources first, or pass --allow-conflicts to take the first source\'s specifier',
    )
  }
  // A `file:`/`link:` specifier resolves relative to the profile that declares
  // it, so copying the string into another profile silently retargets it.
  const localSpecs = candidates.filter(candidate => isLocalSpecifier(candidate.spec))

  const targets = []
  const missingTargets = []
  for (const name of targetNames) {
    const profile = loadProfile(dshHome, name)
    if (profile === undefined) {
      missingTargets.push(name)
      continue
    }
    targets.push(buildTargetPlan(profile, candidates, sourceNames0, options.prune === true))
  }

  const skipped = sources.flatMap(profile => profile.bundles
    .filter(bundle => bundle.kind !== 'user')
    .map(bundle => ({ profile: profile.name, name: bundle.name, reason: bundle.kind })))

  return {
    dshHome,
    sources: sourceNames0,
    candidates,
    conflicts,
    localSpecs,
    targets,
    skipped,
    missingSources,
    missingTargets,
    prune: options.prune === true,
    strict: options.strict === true,
    restartRequired: targets.some(target => target.steps.length > 0),
  }
}

/**
 * Whether a dependency specifier points at local storage rather than a registry.
 * @param {string} spec - dependency specifier.
 * @returns {boolean} true for `file:`, `link:`, `portal:`, or a bare path.
 */
export function isLocalSpecifier(spec) {
  return /^(?:file|link|portal|workspace):/iu.test(spec)
    || spec.startsWith('.')
    || spec.startsWith('/')
    || /^[A-Za-z]:[\\/]/u.test(spec)
}

/**
 * Build the per-target portion of a plan.
 * @param {ProfileRecord} profile - loaded target profile.
 * @param {Array<{name: string, spec: string, from: string}>} candidates - source candidates.
 * @param {string[]} sourceNames - source profile names.
 * @param {boolean} prune - whether to plan removals.
 * @returns {TargetPlan} target plan.
 */
function buildTargetPlan(profile, candidates, sourceNames, prune) {
  const declared = new Set(profile.bundleNames)
  const candidateNames = new Set(candidates.map(candidate => candidate.name))
  const steps = []
  for (const candidate of candidates) {
    if (declared.has(candidate.name)) continue
    steps.push({
      name: candidate.name,
      spec: candidate.spec,
      from: candidate.from,
      action: 'add',
      installRequired: true,
    })
  }
  if (prune) {
    for (const bundle of profile.bundles) {
      if (bundle.kind !== 'user') continue
      if (candidateNames.has(bundle.name)) continue
      steps.push({
        name: bundle.name,
        spec: bundle.spec,
        from: null,
        action: 'remove',
        installRequired: true,
      })
    }
  }
  const aligned = steps.filter(step => step.action === 'add').length === 0
    && steps.filter(step => step.action === 'remove').length === 0
  return {
    name: profile.name,
    dir: profile.dir,
    reserved: profile.reserved,
    steps,
    aligned,
    sources: sourceNames,
  }
}

/**
 * Render the exact manifest text an apply would write, without writing it.
 * @param {ProfileRecord} profile - the profile to modify.
 * @param {TargetPlan} targetPlan - plan for this target.
 * @param {string} recordedAt - ISO timestamp for the ledger entry.
 * @returns {{text: string, raw: Record<string, unknown>, changes: string[]}} the next manifest.
 */
export function renderNextManifest(profile, targetPlan, recordedAt) {
  // Structural share, never a schema rebuild: unknown root keys, `version`,
  // `packageManager`, and sibling `dsh.*` keys keep their value and position.
  // The caller's parsed manifest is never mutated: every container this
  // function touches is rebuilt first, so a plan can be rendered repeatedly
  // (dry run, then apply) with identical output.
  const raw = profile.raw
  const dsh = { ...(raw.dsh ?? {}) }
  const section = { ...(dsh.profile ?? {}) }
  const removed = new Set(targetPlan.steps.filter(step => step.action === 'remove').map(step => step.name))
  const added = targetPlan.steps.filter(step => step.action === 'add')
  const existing = Array.isArray(section.bundles) ? section.bundles : []
  // Appends keep the shipped product prefix and every unrelated bundle exactly
  // where they were; only the new user layers land at the end of the stack.
  const bundles = existing.filter(name => !removed.has(name))
  for (const step of added) {
    if (!bundles.includes(step.name)) bundles.push(step.name)
  }
  section.bundles = bundles
  dsh.profile = section

  const dependencies = { ...(raw.dependencies ?? {}) }
  const changes = []
  for (const step of added) {
    if (dependencies[step.name] !== step.spec) {
      changes.push(`dependencies.${step.name}: ${dependencies[step.name] ?? '(absent)'} -> ${step.spec}`)
      dependencies[step.name] = step.spec
    }
  }
  for (const name of removed) {
    if (Object.hasOwn(dependencies, name)) {
      changes.push(`dependencies.${name}: ${dependencies[name]} -> (removed)`)
      delete dependencies[name]
    }
  }
  if (Object.keys(dependencies).length === 0) delete raw.dependencies
  else raw.dependencies = dependencies

  const ledger = new Set(profile.syncLedger)
  for (const step of added) ledger.add(step.name)
  for (const name of removed) ledger.delete(name)
  dsh[SYNC_LEDGER_KEY] = [...ledger].sort()

  const next = { ...raw, dsh }
  const text = `${JSON.stringify(next, undefined, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error(`profile-sync: refusing to write a manifest larger than ${String(MAX_MANIFEST_BYTES)} bytes for profile ${JSON.stringify(profile.name)}`)
  }
  return { text, raw: next, changes }
}

/**
 * Verify one whole profile: every declared user bundle must be installed.
 *
 * This is deliberately independent of any plan. A plan describes *changes*, so
 * it knows nothing about a profile that is already aligned — and a profile whose
 * manifest names three bundles it never installed is exactly the state a
 * change-only check would call healthy.
 * @param {string} dshHome - absolute DSH home.
 * @param {string} name - profile name.
 * @returns {{present: boolean, declared: string[], missingPackages: string[]}} profile-level verification.
 */
export function verifyProfile(dshHome, name) {
  const profile = loadProfile(dshHome, name)
  if (profile === undefined) {
    return { present: false, declared: [], missingPackages: [] }
  }
  return {
    present: true,
    declared: profile.bundles.filter(bundle => bundle.kind === 'user').map(bundle => bundle.name),
    missingPackages: missingInstallsIn(profile),
  }
}

/**
 * Whether the plan's additions are already satisfied by installed packages.
 * @param {ProfileRecord} profile - loaded target profile.
 * @param {TargetPlan} targetPlan - plan for this target.
 * @returns {string[]} bundle names still missing from `node_modules`.
 */
export function missingInstalls(profile, targetPlan) {
  return targetPlan.steps
    .filter(step => step.action === 'add')
    .map(step => step.name)
    .filter(name => !isPhysicallyInstalled(profile.dir, name))
}

/**
 * Verify a target profile on disk against a plan.
 *
 * Two independent questions are answered, because they fail separately: a
 * manifest can be correct while `node_modules` is still empty (offline run, a
 * failed install, or `--no-install`). Reporting them as one boolean is how an
 * operator ends up trusting a profile that cannot boot.
 *
 * The install check covers **every** user bundle the profile declares, not just
 * the ones this plan adds. A plan describes changes, so a target that needed no
 * change would otherwise look installed no matter what its `node_modules` holds
 * — which is exactly the state that fails to boot.
 * @param {string} dshHome - absolute DSH home.
 * @param {TargetPlan} targetPlan - the plan that was applied.
 * @returns {{aligned: boolean, installed: boolean, declared: number, missingBundles: string[], missingDependencies: string[], missingPackages: string[]}} verification result.
 */
export function verifyTarget(dshHome, targetPlan) {
  const profile = loadProfile(dshHome, targetPlan.name)
  if (profile === undefined) {
    const planned = targetPlan.steps.filter(step => step.action === 'add').map(step => step.name)
    return {
      aligned: false,
      installed: false,
      declared: 0,
      missingBundles: planned,
      missingDependencies: [],
      missingPackages: planned,
    }
  }
  const declared = new Set(profile.bundleNames)
  const missingBundles = []
  const missingDependencies = []
  for (const step of targetPlan.steps) {
    if (step.action !== 'add') continue
    if (!declared.has(step.name)) missingBundles.push(step.name)
    if (profile.dependencies[step.name] !== step.spec) missingDependencies.push(step.name)
  }
  const missingPackages = missingInstallsIn(profile)
  return {
    aligned: missingBundles.length === 0 && missingDependencies.length === 0,
    // `declared` distinguishes "a profile that wants nothing" from "a profile
    // whose every want is satisfied": both report no missing packages, and only
    // one of them is evidence that an install worked.
    declared: profile.bundles.filter(bundle => bundle.kind === 'user').length,
    installed: missingPackages.length === 0,
    missingBundles,
    missingDependencies,
    missingPackages,
  }
}

/**
 * Every declared user bundle with no package in `node_modules`.
 * @param {ProfileRecord} profile - loaded profile.
 * @returns {string[]} bundle names that are declared but not installed.
 */
function missingInstallsIn(profile) {
  return profile.bundles
    .filter(bundle => bundle.kind === 'user' && !bundle.installed)
    .map(bundle => bundle.name)
}

/**
 * Acquire an exclusive advisory lock beside a manifest.
 *
 * A stale lock left by a killed process is reclaimed after the timeout instead
 * of blocking every future run.
 * @param {string} manifestPath - manifest being edited.
 * @param {{timeoutMs?: number, staleMs?: number, now?: () => number}} [options] - lock tuning.
 * @returns {() => void} release function.
 */
export function acquireManifestLock(manifestPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const staleMs = options.staleMs ?? 30000
  const now = options.now ?? Date.now
  const lockPath = `${manifestPath}.profilesync.lock`
  const started = now()
  mkdirSync(dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`)
      closeSync(fd)
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          unlinkSync(lockPath)
        } catch {
          // A lock removed by the stale reclaimer is already gone.
        }
      }
    } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause
      let stale = false
      try {
        stale = now() - statSync(lockPath).mtimeMs > staleMs
      } catch {
        continue
      }
      if (stale) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Another process reclaimed it first; retry the acquisition.
        }
        continue
      }
      if (now() - started > timeoutMs) {
        throw new Error(`profile-sync: timed out waiting for ${lockPath}`)
      }
      sleepSync(50)
    }
  }
}

/**
 * Block the current thread briefly without pulling in a timer dependency.
 * @param {number} ms - milliseconds to sleep.
 */
function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(shared), 0, 0, ms)
}

/**
 * Write a manifest atomically.
 *
 * The temporary file is fsynced before the rename and the original is copied
 * aside first, so a crash leaves either the old manifest or the new one, never
 * a truncated file. On Windows the destination is renamed aside rather than
 * overwritten, because `rename` refuses an existing target there.
 * @param {string} manifestPath - manifest to replace.
 * @param {string} text - complete next content.
 * @param {{backup?: boolean}} [options] - backup control.
 * @returns {string | undefined} path of the backup, when one was kept.
 */
export function writeManifestAtomic(manifestPath, text, options = {}) {
  const directory = dirname(manifestPath)
  mkdirSync(directory, { recursive: true })
  const tempPath = `${manifestPath}.profilesync.${process.pid.toString()}.tmp`
  const backupPath = options.backup === false ? undefined : `${manifestPath}.profilesync.bak`
  const fd = openSync(tempPath, 'w', 0o600)
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    if (backupPath !== undefined && existsSync(manifestPath)) {
      copyFileOverwrite(manifestPath, backupPath)
    }
    renameOverwrite(tempPath, manifestPath)
  } catch (cause) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // The temporary file is best-effort cleanup.
    }
    throw cause
  }
  return backupPath
}

/**
 * Copy a file over an existing destination.
 * @param {string} from - source path.
 * @param {string} to - destination path.
 */
function copyFileOverwrite(from, to) {
  const bytes = readFileSync(from)
  const fd = openSync(to, 'w', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Rename a file onto a path that may already exist.
 * @param {string} from - source path.
 * @param {string} to - destination path.
 */
function renameOverwrite(from, to) {
  try {
    renameSync(from, to)
    return
  } catch (cause) {
    if (cause.code !== 'EEXIST' && cause.code !== 'EPERM') throw cause
  }
  const displaced = `${to}.profilesync.displaced`
  rmSync(displaced, { force: true })
  renameSync(to, displaced)
  try {
    renameSync(from, to)
  } catch (cause) {
    renameSync(displaced, to)
    throw cause
  }
  rmSync(displaced, { force: true })
}

/**
 * Assert that a path is absolute, as required for every launcher-owned path.
 *
 * The check is platform-native: on POSIX `C:\x` is a valid relative filename,
 * so a Windows-style path is accepted only where Windows itself would accept
 * it, which is exactly the platform the launcher runs on.
 * @param {string} label - human-readable label for the error.
 * @param {string} value - candidate path.
 * @returns {string} the resolved absolute path.
 */
export function requireAbsolutePath(label, value) {
  const invalid = typeof value !== 'string'
    || value.trim() === ''
    || value.includes('\0')
    || !isAbsolutePathLike(value)
  if (invalid) {
    throw new Error(`profile-sync: ${label} must be an absolute path without NUL`)
  }
  return resolve(value)
}

/**
 * Whether a path is absolute on this platform.
 * @param {string} value - candidate path.
 * @returns {boolean} true for a drive-letter, UNC, or rooted path.
 */
function isAbsolutePathLike(value) {
  return value.startsWith('/')
    || value.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || /^[A-Za-z]:$/u.test(value)
}

/**
 * @typedef {object} BundleRecord
 * @property {string} name - bundle package name.
 * @property {'product' | 'desktop-owned' | 'user' | 'unknown'} kind - classification.
 * @property {string | undefined} spec - dependency specifier, when declared.
 * @property {boolean} installed - whether the package exists in `node_modules`.
 */

/**
 * @typedef {object} ProfileRecord
 * @property {string} name - profile name.
 * @property {string} dir - absolute profile directory.
 * @property {string} manifestPath - absolute manifest path.
 * @property {boolean} exists - always true for a loaded profile.
 * @property {boolean} reserved - whether DSH Desktop owns the name.
 * @property {Record<string, string>} dependencies - declared dependency specifiers.
 * @property {BundleRecord[]} bundles - classified bundles in composition order.
 * @property {string[]} bundleNames - bundle names in composition order.
 * @property {string[]} syncLedger - bundle names this tool has synced before.
 * @property {Record<string, unknown>} raw - the parsed manifest, kept for structural edits.
 */

/**
 * @typedef {object} TargetPlan
 * @property {string} name - target profile name.
 * @property {string} dir - absolute target profile directory.
 * @property {boolean} reserved - whether DSH Desktop owns the name.
 * @property {Array<{name: string, spec: string, from: string | null, action: 'add' | 'remove', installRequired: boolean}>} steps - planned edits.
 * @property {boolean} aligned - whether no edit is needed.
 * @property {string[]} sources - source profile names the plan was derived from.
 */

/**
 * @typedef {object} SyncPlan
 * @property {string} dshHome - absolute DSH home the plan targets.
 * @property {string[]} sources - source profiles actually loaded.
 * @property {Array<{name: string, spec: string, from: string}>} candidates - union of syncable bundles.
 * @property {Array<{name: string, specs: Array<{from: string, spec: string}>}>} conflicts - bundles declared with different specifiers.
 * @property {Array<{name: string, spec: string, from: string}>} localSpecs - candidates whose specifier resolves relative to the source profile.
 * @property {TargetPlan[]} targets - per-target plans.
 * @property {Array<{profile: string, name: string, reason: string}>} skipped - bundles deliberately not synced.
 * @property {string[]} missingSources - requested sources with no manifest.
 * @property {string[]} missingTargets - requested targets with no manifest.
 * @property {boolean} prune - whether removals were planned.
 * @property {boolean} strict - whether conflicting sources were refused instead of resolved.
 * @property {boolean} restartRequired - whether any target changes.
 */

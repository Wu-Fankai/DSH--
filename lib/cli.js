#!/usr/bin/env node
/**
 * `dsh-profile-sync` — align user-installed plugins across DSH profiles.
 *
 * The default invocation is a dry run: it prints exactly which profile would
 * gain or lose which bundle and writes nothing. `--apply` is the only way to
 * change a manifest, and the plan printed by a dry run is the same object the
 * apply consumes.
 */

import process from 'node:process'
import { applySync } from './apply.js'
import {
  listProfiles,
  planSync,
  resolveDshHome,
  requireAbsolutePath,
  verifyProfile,
} from './sync-core.js'

const USAGE = `dsh-profile-sync — align user-installed plugins across DSH profiles

Usage:
  dsh-profile-sync [options]

Options:
  --from <a,b>        source profiles to collect bundles from (default: web)
  --to <a,b>          target profiles to align              (default: desktop)
  --dsh-home <path>   DSH home directory (default: $DSH_HOME or ~/.dsh)
  --all               collect from every profile and align every profile
  --prune             also remove user bundles the sources do not have
  --allow-conflicts   take the first source's specifier when sources disagree
                      (default: refuse, because a silent pick is not a choice)
  --apply             write the manifests (default is a dry run)
  --no-install        write manifests but do not run the package manager
  --no-backup         do not keep a .bak beside an edited manifest
  --check             exit non-zero when a target is not usable, write nothing
  --json              print the plan or result as JSON
  -h, --help          show this help

Exit codes:
  0  success (a dry run is a success)
  1  --check found a target that is not usable, or --apply failed to write,
     install, or verify
  2  bad arguments, unusable DSH home, or sources that disagree

Examples:
  dsh-profile-sync                          # preview web -> desktop
  dsh-profile-sync --apply                  # do it, then install
  dsh-profile-sync --from web --to desktop --apply
  dsh-profile-sync --all --apply            # make every profile agree
  dsh-profile-sync --check                  # CI gate, no writes
`

/**
 * Parse argv into options.
 * @param {string[]} argv - process arguments after the script name.
 * @returns {CliOptions} parsed options.
 */
export function parseArgs(argv) {
  /** @type {CliOptions} */
  const options = {
    from: undefined,
    to: undefined,
    dshHome: undefined,
    all: false,
    prune: false,
    allowConflicts: false,
    apply: false,
    install: true,
    backup: true,
    check: false,
    json: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const [flag, inlineValue] = token.startsWith('--') && token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, undefined]
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue
      index += 1
      const value = argv[index]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`profile-sync: ${flag} requires a value`)
      }
      return value
    }
    switch (flag) {
      case '--from':
        options.from = splitList(takeValue())
        break
      case '--to':
        options.to = splitList(takeValue())
        break
      case '--dsh-home':
        options.dshHome = takeValue()
        break
      case '--all':
        options.all = true
        break
      case '--prune':
        options.prune = true
        break
      case '--allow-conflicts':
        options.allowConflicts = true
        break
      case '--apply':
        options.apply = true
        break
      case '--no-install':
        options.install = false
        break
      case '--no-backup':
        options.backup = false
        break
      case '--check':
        options.check = true
        break
      case '--json':
        options.json = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`profile-sync: unknown argument ${JSON.stringify(token)}`)
    }
  }
  if (options.check && options.apply) {
    throw new Error('profile-sync: --check and --apply are mutually exclusive')
  }
  return options
}

/**
 * Split a comma-separated profile list.
 * @param {string} value - raw option value.
 * @returns {string[]} trimmed non-empty names.
 */
function splitList(value) {
  const names = value.split(',').map(part => part.trim()).filter(part => part !== '')
  if (names.length === 0) throw new Error('profile-sync: expected at least one profile name')
  return names
}

/**
 * Resolve the effective source and target profile sets.
 * @param {CliOptions} options - parsed options.
 * @param {string} dshHome - absolute DSH home.
 * @returns {{sources: string[], targets: string[]}} resolved profile names.
 */
export function resolveProfileSets(options, dshHome) {
  const discovered = listProfiles(dshHome)
  if (options.all) {
    if (discovered.length === 0) throw new Error(`profile-sync: no profiles found under ${dshHome}`)
    return { sources: discovered, targets: discovered }
  }
  const sources = options.from ?? ['web']
  const targets = options.to ?? (sources.includes('desktop') ? ['web'] : ['desktop'])
  return { sources, targets }
}

/**
 * Run the CLI.
 * @param {string[]} argv - process arguments after the script name.
 * @param {{env?: NodeJS.ProcessEnv, stdout?: (text: string) => void, stderr?: (text: string) => void}} [io] - injectable IO for tests.
 * @returns {Promise<number>} process exit code.
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env
  const out = io.stdout ?? (text => { process.stdout.write(text) })
  const err = io.stderr ?? (text => { process.stderr.write(text) })
  let options
  try {
    options = parseArgs(argv)
  } catch (cause) {
    err(`${cause.message}\n\n${USAGE}`)
    return 2
  }
  if (options.help) {
    out(USAGE)
    return 0
  }

  let dshHome
  try {
    dshHome = options.dshHome === undefined
      ? resolveDshHome(env)
      : requireAbsolutePath('--dsh-home', options.dshHome)
  } catch (cause) {
    err(`${cause.message}\n`)
    return 2
  }

  let sources
  let targets
  try {
    ({ sources, targets } = resolveProfileSets(options, dshHome))
  } catch (cause) {
    err(`${cause.message}\n`)
    return 2
  }

  let plan
  try {
    plan = planSync({
      dshHome,
      sources,
      targets,
      prune: options.prune,
      // Conflicting sources are refused by default: silently taking the first
      // specifier installs a version nobody chose.
      strict: !options.allowConflicts,
    })
  } catch (cause) {
    err(`${cause.message}\n`)
    return 2
  }

  if (options.json && !options.apply) {
    out(`${JSON.stringify(plan, undefined, 2)}\n`)
  } else if (!options.json) {
    out(renderPlan(plan))
  }

  if (options.check) {
    const unusable = plan.targets.filter(target => !target.aligned)
    if (unusable.length > 0) {
      err(`profile-sync: ${unusable.map(target => target.name).join(', ')} not aligned\n`)
      return 1
    }
    if (options.install) {
      const uninstalled = plan.targets
        .map(target => ({ target: target.name, missing: verifyProfile(plan.dshHome, target.name).missingPackages }))
        .filter(entry => entry.missing.length > 0)
      if (uninstalled.length > 0) {
        err(`profile-sync: ${uninstalled.map(entry => `${entry.target} (${entry.missing.join(', ')})`).join(', ')} declared but not installed\n`)
        return 1
      }
      const absentTargets = plan.targets.filter(target => !verifyProfile(plan.dshHome, target.name).present)
      if (absentTargets.length > 0) {
        err(`profile-sync: ${absentTargets.map(target => target.name).join(', ')} has no manifest\n`)
        return 1
      }
    }
    return 0
  }

  if (!options.apply) {
    if (!options.json) {
      out('\nDry run. Re-run with --apply to write these manifests.\n')
    }
    return 0
  }

  const result = await applySync(plan, {
    install: options.install,
    backup: options.backup,
    onEvent: event => {
      if (options.json) return
      out(`${renderEvent(event)}\n`)
    },
  })

  if (options.json) {
    out(`${JSON.stringify(result, undefined, 2)}\n`)
  } else {
    out(`\n${renderResult(result)}\n`)
  }

  const failed = result.results.filter(entry =>
    entry.status === 'write-failed'
    || entry.status === 'applied-install-failed'
    || entry.status === 'missing')
  const misaligned = result.results.filter(entry => entry.verification !== undefined && !entry.verification.aligned)
  // Packages still absent after an install attempt is a real failure: the
  // profile declares a bundle it cannot load, so a success code would be a lie.
  const notInstalled = options.install
    ? result.results.filter(entry => entry.verification !== undefined && !entry.verification.installed)
    : []
  for (const entry of notInstalled) {
    err(`profile-sync: ${entry.name}: declared but not installed (${entry.verification.missingPackages.join(', ')})\n`)
  }
  if (failed.length > 0 || misaligned.length > 0 || notInstalled.length > 0) return 1
  if (result.wroteAny) {
    out('\nRestart DSH (and DSH Desktop, if it is running) so the new bundle layers enter the Loader composition.\n')
  }
  return 0
}

/**
 * Render the plan as a human-readable report.
 * @param {import('./sync-core.js').SyncPlan} plan - the plan.
 * @returns {string} report text.
 */
export function renderPlan(plan) {
  const lines = []
  lines.push(`DSH home:   ${plan.dshHome}`)
  lines.push(`Sources:    ${plan.sources.join(', ')}`)
  if (plan.missingSources.length > 0) {
    lines.push(`Missing:    ${plan.missingSources.join(', ')} (no manifest, skipped as a source)`)
  }
  lines.push('')
  lines.push(`Syncable user bundles (${String(plan.candidates.length)}):`)
  if (plan.candidates.length === 0) {
    lines.push('  (none — every declared bundle is a DSH product or Desktop-owned bundle)')
  }
  for (const candidate of plan.candidates) {
    lines.push(`  ${candidate.name}  ${candidate.spec}  (from ${candidate.from})`)
  }
  if (plan.conflicts.length > 0) {
    lines.push('')
    lines.push(plan.strict === true
      ? 'Specifier conflicts (refused: sources disagree, align them or pass --allow-conflicts):'
      : 'Specifier conflicts (--allow-conflicts: first source wins, review before applying):')
    for (const conflict of plan.conflicts) {
      lines.push(`  ${conflict.name}: ${conflict.specs.map(pair => `${pair.spec} (${pair.from})`).join(' vs ')}`)
    }
  }
  if (plan.skipped.length > 0) {
    lines.push('')
    lines.push('Deliberately not synced:')
    for (const entry of plan.skipped) {
      lines.push(`  ${entry.profile}: ${entry.name} (${entry.reason})`)
    }
  }
  if (plan.localSpecs !== undefined && plan.localSpecs.length > 0) {
    lines.push('')
    lines.push('Local specifiers (verified by the package manager, not by path rewrites):')
    for (const entry of plan.localSpecs) {
      lines.push(`  ${entry.name}  ${entry.spec}  (from ${entry.from})`)
    }
  }
  lines.push('')
  for (const target of plan.targets) {
    lines.push(`Target ${target.name}${target.reserved ? ' (managed by DSH Desktop)' : ''}: ${target.dir}`)
    if (target.aligned) {
      lines.push('  already aligned')
      continue
    }
    for (const step of target.steps) {
      const verb = step.action === 'add' ? '+' : '-'
      const origin = step.from === null ? '' : `  (from ${step.from})`
      lines.push(`  ${verb} ${step.name}  ${step.spec}${origin}`)
    }
  }
  for (const missing of plan.missingTargets) {
    lines.push(`Target ${missing}: no manifest at this DSH home; create the profile first`)
  }
  if (!plan.restartRequired) {
    lines.push('')
    lines.push('Every target is already aligned; nothing to do.')
  }
  return `${lines.join('\n')}\n`
}

/**
 * Render one apply event as a single line.
 * @param {import('./apply.js').ApplyEvent} event - the event.
 * @returns {string} report text.
 */
export function renderEvent(event) {
  switch (event.type) {
    case 'target-aligned':
      return `[=] ${event.target}: already aligned`
    case 'target-missing':
      return `[!] ${event.target}: no manifest, skipped`
    case 'target-written':
      return `[+] ${event.target}: wrote manifest (${String(event.changes?.length ?? 0)} change(s))${event.backup === undefined ? '' : `, backup ${event.backup}`}`
    case 'target-write-failed':
      return `[x] ${event.target}: manifest write failed: ${event.error}`
    case 'install-start':
      return `[>] ${event.target}: ${event.label} install in ${event.dir}`
    case 'install-done':
      return `[>] ${event.target}: package manager exited ${String(event.code)}`
    case 'install-failed':
      return `[x] ${event.target}: package manager failed: ${event.error}`
    case 'install-skipped':
      return `[.] ${event.target}: install skipped (${event.reason})`
    case 'verify-failed':
      return `[x] ${event.target}: verify failed — bundles: ${event.missingBundles?.join(', ') || 'none'}; dependencies: ${event.missingDependencies?.join(', ') || 'none'}; packages: ${event.missingPackages?.join(', ') || 'none'}`
    default:
      return `[?] ${event.type}`
  }
}

/**
 * Render the apply result summary.
 * @param {import('./apply.js').ApplyResult} result - apply result.
 * @returns {string} report text.
 */
export function renderResult(result) {
  const lines = []
  for (const entry of result.results) {
    const detail = entry.status === 'applied' || entry.status === 'applied-install-failed'
      ? ` (${String(entry.changes.length)} manifest change(s)${entry.installed ? ', installed' : ''})`
      : ''
    lines.push(`${entry.name}: ${entry.status}${detail}`)
    if (entry.error !== undefined) lines.push(`  error: ${entry.error}`)
    if (entry.verification !== undefined && !entry.verification.aligned) {
      lines.push(`  still missing bundles: ${entry.verification.missingBundles.join(', ') || 'none'}`)
      lines.push(`  still missing packages: ${entry.verification.missingPackages.join(', ') || 'none'}`)
    }
  }
  return lines.join('\n')
}

/**
 * @typedef {object} CliOptions
 * @property {string[] | undefined} from - source profiles.
 * @property {string[] | undefined} to - target profiles.
 * @property {string | undefined} dshHome - explicit DSH home.
 * @property {boolean} all - use every discovered profile.
 * @property {boolean} prune - plan removals.
 * @property {boolean} allowConflicts - resolve conflicting specifiers instead of refusing.
 * @property {boolean} apply - write changes.
 * @property {boolean} install - run the package manager.
 * @property {boolean} backup - keep a backup manifest.
 * @property {boolean} check - non-zero exit when unaligned.
 * @property {boolean} json - machine-readable output.
 * @property {boolean} help - print usage.
 */

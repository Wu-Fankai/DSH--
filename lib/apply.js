/**
 * Side-effecting half of cross-Profile plugin sync.
 *
 * `lib/sync-core.js` decides what should change; this file is the only place
 * that writes a manifest or starts a package manager, so a dry run and a real
 * run can never disagree about the plan itself.
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import {
  acquireManifestLock,
  loadProfile,
  missingInstalls,
  renderNextManifest,
  writeManifestAtomic,
  verifyTarget,
} from './sync-core.js'

/**
 * Apply a computed plan.
 *
 * Each target is edited under its own manifest lock: the manifest is written
 * first and the package manager runs second, so an install failure leaves a
 * manifest that is honest about what the profile now wants.
 * @param {import('./sync-core.js').SyncPlan} plan - plan from `planSync`.
 * @param {object} [options] - apply options.
 * @param {boolean} [options.install] - run the package manager after writing (default true).
 * @param {(event: ApplyEvent) => void} [options.onEvent] - progress callback.
 * @param {boolean} [options.backup] - keep a `.bak` beside each edited manifest (default true).
 * @param {boolean} [options.verify] - re-read each target after applying (default true).
 * @param {PnpmInvocation} [options.pnpm] - explicit package-manager invocation.
 * @param {AbortSignal} [options.signal] - abort the install stage.
 * @param {() => string} [options.now] - clock used for the ledger timestamp.
 * @returns {Promise<ApplyResult>} per-target outcomes.
 */
export async function applySync(plan, options = {}) {
  const onEvent = options.onEvent ?? (() => {})
  const install = options.install !== false
  const backup = options.backup !== false
  // A conflicting source set is refused before anything is written. `planSync`
  // already enforces this in strict mode; repeating it here means no caller can
  // reach a write through a plan that was built with the looser setting.
  if (plan.conflicts !== undefined && plan.conflicts.length > 0 && plan.strict === true) {
    throw new Error(
      `profile-sync: refusing to apply ${String(plan.conflicts.length)} conflicting specifier(s); `
      + 'build the plan with strict: false only after deciding which source wins',
    )
  }
  const recordedAt = (options.now ?? (() => new Date().toISOString()))()
  const results = []

  for (const target of plan.targets) {
    if (target.steps.length === 0) {
      // An already-aligned target still reports its verification: "nothing to
      // write" and "nothing missing" are different claims, and only the second
      // one justifies a success exit code.
      const verification = options.verify === false ? undefined : verifyTarget(plan.dshHome, target)
      results.push({
        name: target.name,
        status: 'aligned',
        changes: [],
        installed: false,
        ...(verification === undefined ? {} : { verification }),
      })
      onEvent({ type: 'target-aligned', target: target.name })
      continue
    }

    const profile = loadProfile(plan.dshHome, target.name)
    if (profile === undefined) {
      results.push({
        name: target.name,
        status: 'missing',
        changes: [],
        installed: false,
        verification: { aligned: false, installed: false, missingBundles: [], missingDependencies: [], missingPackages: [] },
      })
      onEvent({ type: 'target-missing', target: target.name })
      continue
    }

    const release = acquireManifestLock(profile.manifestPath)
    let changes = []
    let backupPath
    try {
      const rendered = renderNextManifest(profile, target, recordedAt)
      changes = rendered.changes
      backupPath = writeManifestAtomic(profile.manifestPath, rendered.text, { backup })
      onEvent({ type: 'target-written', target: target.name, changes: [...changes], backup: backupPath })
    } catch (cause) {
      release()
      results.push({
        name: target.name,
        status: 'write-failed',
        changes,
        installed: false,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      onEvent({ type: 'target-write-failed', target: target.name, error: String(cause) })
      continue
    }
    release()

    let installed = false
    let installError
    let installSkipped
    if (install) {
      const reloaded = loadProfile(plan.dshHome, target.name)
      const stillMissing = reloaded === undefined ? target.steps.map(step => step.name) : missingInstalls(reloaded, target)
      if (stillMissing.length === 0) {
        onEvent({ type: 'install-skipped', target: target.name, reason: 'already-installed' })
        installSkipped = 'already-installed'
      } else {
        try {
          const outcome = await runPnpmInstall(target.dir, {
            ...(options.pnpm === undefined ? {} : { pnpm: options.pnpm }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onEvent: event => onEvent({ ...event, target: target.name }),
          })
          installed = true
          onEvent({ type: 'install-done', target: target.name, code: outcome.code })
        } catch (cause) {
          installError = cause instanceof Error ? cause.message : String(cause)
          onEvent({ type: 'install-failed', target: target.name, error: installError })
        }
      }
    } else {
      onEvent({ type: 'install-skipped', target: target.name, reason: 'disabled' })
      installSkipped = 'disabled'
    }

    const verification = options.verify === false ? undefined : verifyTarget(plan.dshHome, target)
    results.push({
      name: target.name,
      status: installError === undefined ? 'applied' : 'applied-install-failed',
      changes,
      installed,
      ...(installSkipped === undefined ? {} : { installSkipped }),
      ...(backupPath === undefined ? {} : { backup: backupPath }),
      ...(installError === undefined ? {} : { error: installError }),
      ...(verification === undefined ? {} : { verification }),
    })
    if (verification !== undefined && (!verification.aligned || !verification.installed)) {
      onEvent({
        type: 'verify-failed',
        target: target.name,
        missingBundles: verification.missingBundles,
        missingDependencies: verification.missingDependencies,
        missingPackages: verification.missingPackages,
      })
    }
  }

  return {
    dshHome: plan.dshHome,
    results,
    wroteAny: results.some(result => result.status === 'applied' || result.status === 'applied-install-failed'),
  }
}

/**
 * The ordered candidates for a package-manager invocation.
 * @returns {Array<{command: string, prefixArgs: string[], label: string}>} candidates in preference order.
 */
export function pnpmInvocationCandidates() {
  return [
    { command: 'pnpm', prefixArgs: [], label: 'pnpm' },
    { command: 'corepack', prefixArgs: ['pnpm'], label: 'corepack pnpm' },
  ]
}

/**
 * Run `install` in a profile directory.
 *
 * Output is inherited rather than piped: a package manager can be interactive,
 * and the operator should see progress instead of a silent wait. The exit code
 * and terminating signal are both reported, because a killed install is not a
 * successful install.
 * @param {string} profileDir - absolute profile directory.
 * @param {object} [options] - invocation options.
 * @param {PnpmInvocation} [options.pnpm] - explicit invocation, skipping detection.
 * @param {AbortSignal} [options.signal] - abort the child process.
 * @param {(event: {type: string, [key: string]: unknown}) => void} [options.onEvent] - progress callback.
 * @returns {Promise<{code: number | null, signal: NodeJS.Signals | null, label: string}>} the outcome.
 */
export async function runPnpmInstall(profileDir, options = {}) {
  const onEvent = options.onEvent ?? (() => {})
  const attempts = options.pnpm === undefined
    ? pnpmInvocationCandidates().map(candidate => resolveInvocation(candidate))
    : [resolveInvocation(options.pnpm)]
  /** @type {string[]} */
  const failures = []
  for (const attempt of attempts) {
    if (attempt.executable === undefined) {
      failures.push(`${attempt.label} is not available`)
      continue
    }
    onEvent({
      type: 'install-start',
      command: attempt.executable,
      args: attempt.prefixArgs,
      dir: profileDir,
      label: attempt.label,
    })
    const outcome = await spawnAndWait(
      attempt.executable,
      [...attempt.prefixArgs, 'install', '--no-frozen-lockfile'],
      profileDir,
      options.signal,
    )
    if (outcome.code === 0) return { ...outcome, label: attempt.label }
    failures.push(`${attempt.label} exited with ${String(outcome.code)}${outcome.signal === null ? '' : ` (signal ${outcome.signal})`}`)
  }
  throw new Error(`profile-sync: no package manager could install (${failures.join('; ')})`)
}

/**
 * Resolve a candidate to an executable that exists on this host.
 *
 * Resolution happens before spawning so the decision of *how* to start a
 * candidate is made from the file that will actually run, not from a guess.
 * @param {{command: string, prefixArgs: string[], label: string}} candidate - configured candidate.
 * @returns {{executable: string | undefined, prefixArgs: string[], label: string}} the resolved candidate.
 */
export function resolveInvocation(candidate) {
  return {
    executable: resolveExecutable(candidate.command),
    prefixArgs: [...candidate.prefixArgs],
    label: candidate.label,
  }
}

/**
 * Resolve a command name to an existing executable.
 *
 * Candidates are ordered by *runnability*, not by directory, because the
 * variants of one command live in different directories. A package manager
 * installed by npm leaves an extensionless POSIX shell script and a `.cmd` shim
 * beside each other, while the real `.exe` binary sits inside the package's own
 * `node_modules` directory. `spawn` refuses the extensionless and `.ps1` forms
 * outright, so the native `.exe` must be searched across every PATH entry
 * before a `.cmd` shim is accepted, and a `.cmd` before an extensionless file.
 *
 * On POSIX none of this applies: there is exactly one form, and exec resolves
 * the name itself.
 * @param {string} command - executable name or path.
 * @returns {string | undefined} an absolute executable path, or undefined.
 */
export function resolveExecutable(command) {
  if (process.platform !== 'win32') {
    return resolveUnixExecutable(command)
  }
  // Runnable directly by CreateProcess.
  const native = findOnPath(command, ['.exe', '.com'])
  if (native !== undefined) return native
  // Command scripts; these need `cmd.exe`, which `spawnTarget` arranges.
  const script = findOnPath(command, ['.cmd', '.bat'])
  if (script !== undefined) return script
  // Last resort: an extensionless file, which only works if it happens to be a
  // real executable rather than a shell script.
  return findOnPath(command, [''])
}

/**
 * Resolve a command on a POSIX host.
 * @param {string} command - executable name or path.
 * @returns {string | undefined} an absolute executable path, or undefined.
 */
function resolveUnixExecutable(command) {
  if (isAbsolute(command)) return isRunnable(command) ? command : undefined
  for (const directory of pathDirectories()) {
    const candidate = join(directory, command)
    if (isRunnable(candidate)) return candidate
  }
  return undefined
}

/**
 * Find the first PATH entry that holds one of the given extensions.
 * @param {string} command - executable name, or an absolute path.
 * @param {string[]} extensions - extensions to try, most runnable first.
 * @returns {string | undefined} an absolute path, or undefined.
 */
function findOnPath(command, extensions) {
  if (isAbsolute(command)) {
    return isRunnable(command) ? command : undefined
  }
  for (const extension of extensions) {
    for (const directory of pathDirectories()) {
      const candidate = join(directory, `${command}${extension}`)
      if (isRunnable(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * The PATH entries worth searching.
 * @returns {string[]} non-empty absolute directory candidates.
 */
function pathDirectories() {
  return (process.env.PATH ?? '').split(delimiter).filter(entry => entry !== '')
}

/**
 * Whether a path is an existing runnable file.
 * @param {string} candidate - path to test.
 * @returns {boolean} true when the path is a file that can be executed.
 */
function isRunnable(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false
    // Execute permission is only meaningful on POSIX; `X_OK` is a no-op on
    // Windows, where the filesystem does not carry the bit.
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Build the spawn target for one command.
 *
 * `spawn` refuses a Windows command script directly (`EINVAL`), and Node
 * implements `shell: true` by handing the command line to `cmd.exe` with its own
 * escaping. That is the only reliably correct way to start an npm `.cmd` shim:
 * building the `cmd.exe` command line by hand is what gets the quoting wrong,
 * and `cmd.exe` is not the same parser as `CommandLineToArgvW`.
 *
 * The injection risk that `shell: true` normally carries does not apply here,
 * because this tool never puts foreign data on that command line: every
 * argument is one of this file's own literals (`install`,
 * `--no-frozen-lockfile`) or a fixed candidate prefix (`pnpm`), and the
 * executable is a path resolved from PATH. No package name, profile name, or
 * manifest value ever reaches the shell.
 * @param {string} command - an executable path or a bare command name.
 * @param {string[]} args - argv for the command.
 * @returns {{file: string, args: string[], shell: boolean}} the spawn target.
 */
export function spawnTarget(command, args) {
  const isCommandScript = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)
  return {
    file: command,
    args: [...args],
    // A native `.exe` needs no shell; a `.cmd`/`.bat` shim cannot run without one.
    shell: isCommandScript,
  }
}

/**
 * Spawn one command and resolve when its process tree settles.
 * @param {string} command - executable name or path.
 * @param {string[]} args - argv, never a shell string.
 * @param {string} cwd - working directory.
 * @param {AbortSignal | undefined} signal - abort signal.
 * @returns {Promise<{code: number | null, signal: NodeJS.Signals | null}>} the exit outcome.
 */
function spawnAndWait(command, args, cwd, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted === true) {
      rejectPromise(new Error(`profile-sync: ${command} was aborted before it started`))
      return
    }
    const target = spawnTarget(command, args)
    const child = spawn(target.file, target.args, {
      cwd,
      stdio: 'inherit',
      shell: target.shell,
      windowsHide: true,
    })
    let settled = false
    const abort = () => {
      if (settled) return
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', error => {
      settled = true
      signal?.removeEventListener('abort', abort)
      rejectPromise(error)
    })
    child.once('close', (code, termSignal) => {
      settled = true
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted === true) {
        rejectPromise(new Error(`profile-sync: ${command} was aborted`))
        return
      }
      resolvePromise({ code, signal: termSignal })
    })
  })
}

/**
 * Whether a profile directory already has an installed dependency tree.
 * @param {string} profileDir - absolute profile directory.
 * @returns {boolean} true when `node_modules` exists.
 */
export function hasInstalledTree(profileDir) {
  return existsSync(`${profileDir}/node_modules`) || existsSync(`${profileDir}\\node_modules`)
}

/**
 * @typedef {object} PnpmInvocation
 * @property {string} command - executable name or absolute path.
 * @property {string[]} prefixArgs - arguments placed before `install`.
 * @property {string} label - human-readable name used in messages.
 */

/**
 * @typedef {object} ApplyEvent
 * @property {string} type - event kind.
 * @property {string} [target] - target profile name.
 * @property {string[]} [changes] - manifest changes written.
 * @property {string} [backup] - backup path, when one was kept.
 * @property {string} [error] - failure message.
 * @property {number | null} [code] - child exit code.
 * @property {string} [reason] - why a step was skipped.
 */

/**
 * @typedef {object} ApplyResult
 * @property {string} dshHome - absolute DSH home that was edited.
 * @property {Array<{name: string, status: string, changes: string[], installed: boolean, [key: string]: unknown}>} results - per-target outcomes.
 * @property {boolean} wroteAny - whether any manifest was replaced.
 */

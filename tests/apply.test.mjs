/**
 * Apply-stage tests: manifest writing, verification, install failure handling,
 * and how a package manager is located and started on each platform.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'

import {
  applySync,
  pnpmInvocationCandidates,
  resolveExecutable,
  spawnTarget,
} from '../lib/apply.js'
import { planSync, verifyTarget } from '../lib/sync-core.js'
import { PRODUCT_PREFIX, desktopManifest, makeHome, markInstalled, readManifest, webManifest, writeProfile } from './helpers.mjs'

/** Product prefixes plus a plugin name used by the install-failure fixtures. */
const INSTALL_PLUGIN = 'dsh-find-plugin'

test('apply writes the manifest, preserves unknown keys, and verifies', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', {
    name: 'dsh-profile-desktop',
    version: '9.9.9',
    packageManager: 'pnpm@11.8.0',
    dependencies: {},
    custom: { keep: 'me' },
    dsh: { profile: { bundles: [...PRODUCT_PREFIX] } },
  })
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  // Install is disabled and the packages are pre-seeded, so the suite stays
  // offline while still exercising the real verification path.
  for (const step of plan.targets[0].steps) markInstalled(home, 'desktop', step.name)

  const result = await applySync(plan, { install: false, backup: false })
  assert.equal(result.wroteAny, true)
  assert.equal(result.results[0].status, 'applied')
  assert.equal(result.results[0].verification.aligned, true)
  assert.equal(result.results[0].verification.installed, true)

  const manifest = readManifest(home, 'desktop')
  assert.equal(manifest.version, '9.9.9')
  assert.equal(manifest.packageManager, 'pnpm@11.8.0')
  assert.deepEqual(manifest.custom, { keep: 'me' })
  assert.deepEqual(manifest.dsh.profile.bundles, [
    ...PRODUCT_PREFIX,
    '@noob-stupid/dsh-plugin-console',
    'dsh-find-plugin',
    'dshmarket',
  ])
  assert.equal(manifest.dependencies['dshmarket'], '^1.54.0')
  assert.deepEqual(manifest.dsh.profileSyncLedger, [
    '@noob-stupid/dsh-plugin-console',
    'dsh-find-plugin',
    'dshmarket',
  ])
})

test('apply keeps a backup and reports its path', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  for (const step of plan.targets[0].steps) markInstalled(home, 'desktop', step.name)
  const result = await applySync(plan, { install: false })
  const backup = result.results[0].backup
  assert.ok(backup, 'a backup path must be reported')
  assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), desktopManifest())
})

test('apply refuses to touch a profile whose manifest is missing', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  rmSync(join(home, 'profiles', 'desktop'), { recursive: true, force: true })
  const result = await applySync(plan, { install: false })
  assert.equal(result.results[0].status, 'missing')
  assert.equal(result.wroteAny, false)
  assert.equal(result.results[0].verification.aligned, false)
})

test('an already-aligned target still reports its install state', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  await applySync(plan, { install: false, backup: false })

  const aligned = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  assert.equal(aligned.targets[0].aligned, true)
  const result = await applySync(aligned, { install: false })
  assert.equal(result.results[0].status, 'aligned')
  assert.equal(result.results[0].verification.aligned, true)
  assert.equal(result.results[0].verification.installed, false, 'the packages are still absent')
  assert.equal(result.wroteAny, false)
})

test('a failing install is reported without hiding the manifest write', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  const result = await applySync(plan, {
    backup: false,
    // A real interpreter with a failing script: the package manager starts and
    // exits non-zero, which is the failure mode an operator actually hits.
    pnpm: { command: process.execPath, prefixArgs: ['-e', 'process.exit(3)'], label: 'failing-pnpm' },
  })
  assert.equal(result.results[0].status, 'applied-install-failed')
  assert.match(result.results[0].error, /failing-pnpm exited with 3/u)
  assert.equal(readManifest(home, 'desktop').dependencies[INSTALL_PLUGIN], '0.4.0')
  assert.equal(result.results[0].verification.aligned, true)
})

test('an unavailable package manager is reported and never spawned through a shell', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  const result = await applySync(plan, {
    backup: false,
    pnpm: { command: 'definitely-not-a-real-binary-xyz', prefixArgs: [], label: 'bogus' },
  })
  assert.equal(result.results[0].status, 'applied-install-failed')
  assert.match(result.results[0].error, /no package manager could install \(bogus is not available\)/u)
})

test('a strict plan cannot reach a write even when apply is called directly', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', {
    name: 'p',
    dependencies: { 'shared-plugin': '1.0.0' },
    dsh: { profile: { bundles: [...PRODUCT_PREFIX, 'shared-plugin'] } },
  })
  writeProfile(home, 'work', {
    name: 'p',
    dependencies: { 'shared-plugin': '0.9.0' },
    dsh: { profile: { bundles: [...PRODUCT_PREFIX, 'shared-plugin'] } },
  })
  writeProfile(home, 'desktop', desktopManifest())
  const loose = planSync({ dshHome: home, sources: ['web', 'work'], targets: ['desktop'] })
  await assert.rejects(
    () => applySync({ ...loose, strict: true }, { install: false, backup: false }),
    /refusing to apply 1 conflicting specifier/u,
  )
  assert.equal(readManifest(home, 'desktop').dependencies['shared-plugin'], undefined)
})

test('spawnTarget only asks for a shell when a command script needs one', () => {
  const native = spawnTarget('/usr/bin/pnpm', ['install'])
  assert.equal(native.shell, false)
  assert.deepEqual(native.args, ['install'])
  const script = spawnTarget('C:\\npm\\pnpm.cmd', ['install', '--no-frozen-lockfile'])
  assert.deepEqual(script.args, ['install', '--no-frozen-lockfile'])
  // Node refuses a `.cmd` without a shell (EINVAL) and cannot execute an
  // extensionless POSIX script at all, so only the command-script case is
  // allowed to opt into `cmd.exe`.
  assert.equal(script.shell, process.platform === 'win32')
  assert.equal(spawnTarget('C:\\npm\\pnpm.exe', ['install']).shell, false)
  assert.equal(spawnTarget('/usr/local/bin/pnpm.bat', ['install']).shell, process.platform === 'win32')
})

test('resolveExecutable finds a package manager on this host or reports none', () => {
  const nowhere = resolveExecutable('definitely-not-a-real-binary-xyz')
  assert.equal(nowhere, undefined)
  const found = resolveExecutable(process.execPath)
  assert.equal(found, process.execPath, 'an absolute existing executable resolves to itself')
  if (process.platform === 'win32') {
    const pnpm = resolveExecutable('pnpm')
    if (pnpm !== undefined) assert.equal(pnpm.toLowerCase().endsWith('.ps1'), false)
  }
})

test('resolveExecutable prefers a runnable shim over a bare POSIX script', (t) => {
  // A package manager installed by npm leaves an extensionless shell script, a
  // `.cmd` shim, and a `.ps1` script side by side. Only the `.cmd` (or `.exe`)
  // form can be started without a shell, so the extensionless match must lose.
  //
  // The fixtures are given the execute bit explicitly: this test is about which
  // candidate wins, and on POSIX `writeFileSync` alone produces a 0644 file that
  // `accessSync(X_OK)` correctly rejects. Leaving that implicit is what made the
  // first CI run fail on Linux and macOS while passing on Windows, where X_OK is
  // a no-op.
  const dir = mkdtempSync(join(tmpdir(), 'psync-path-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  writeFileSync(join(dir, 'fakepm'), '#!/bin/sh\nexit 0\n')
  writeFileSync(join(dir, 'fakepm.cmd'), '@echo off\r\n')
  writeFileSync(join(dir, 'fakepm.ps1'), 'exit 0\r\n')
  if (process.platform !== 'win32') chmodSync(join(dir, 'fakepm'), 0o755)

  const previousPath = process.env.PATH
  process.env.PATH = dir
  try {
    const resolved = resolveExecutable('fakepm')
    assert.ok(resolved !== undefined, 'a fixture with the execute bit must resolve')
    if (process.platform === 'win32') {
      assert.equal(resolved.toLowerCase().endsWith('.cmd'), true)
    } else {
      assert.equal(resolved, join(dir, 'fakepm'))
    }
    assert.equal(resolveExecutable(join(dir, 'fakepm.cmd')), join(dir, 'fakepm.cmd'))
    // A native executable anywhere on PATH wins over any command script, since
    // the real binary and the npm shims live in different directories.
    const nativeDir = mkdtempSync(join(tmpdir(), 'psync-native-'))
    t.after(() => { rmSync(nativeDir, { recursive: true, force: true }) })
    writeFileSync(join(nativeDir, 'fakepm.exe'), 'MZ')
    if (process.platform !== 'win32') chmodSync(join(nativeDir, 'fakepm.exe'), 0o755)
    process.env.PATH = `${dir}${delimiter}${nativeDir}`
    const preferred = resolveExecutable('fakepm')
    if (process.platform === 'win32') assert.equal(preferred, join(nativeDir, 'fakepm.exe'))
    else assert.equal(preferred, join(dir, 'fakepm'))
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
})

test('a non-executable file is not mistaken for a command', (t) => {
  // On POSIX the execute bit is the difference between "a command" and "a file
  // that happens to be named like one". On Windows the filesystem carries no
  // such bit, so a plain file is accepted there and only there.
  const dir = mkdtempSync(join(tmpdir(), 'psync-mode-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  writeFileSync(join(dir, 'plaincmd'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'plaincmd'), 0o644)

  const previousPath = process.env.PATH
  process.env.PATH = dir
  try {
    const resolved = resolveExecutable('plaincmd')
    if (process.platform === 'win32') {
      assert.equal(resolved, join(dir, 'plaincmd'), 'X_OK is a no-op on Windows')
    } else {
      assert.equal(resolved, undefined, 'a 0644 file is not runnable on POSIX')
      chmodSync(join(dir, 'plaincmd'), 0o755)
      assert.equal(resolveExecutable('plaincmd'), join(dir, 'plaincmd'))
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
})

test('pnpm candidates are ordered pnpm then corepack', () => {
  assert.deepEqual(pnpmInvocationCandidates().map(candidate => candidate.label), ['pnpm', 'corepack pnpm'])
})

test('a real install either succeeds fully or fails loudly, never silently', { skip: process.env.CI === 'true' ? 'needs a registry; the suite is offline by design' : false }, async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  // This is the only test that lets the real package manager run, so it is
  // skipped under CI: a runner without pnpm or without registry access would
  // otherwise turn an environment fact into a red build. Both outcomes are
  // accepted locally — but a success that leaves packages missing is not.
  const result = await applySync(plan, { backup: false })
  const entry = result.results[0]
  if (entry.status === 'applied') {
    assert.equal(entry.installed, true, 'a successful install must have installed something')
    assert.equal(entry.verification.installed, true, 'every declared bundle must be present')
  } else {
    assert.equal(entry.status, 'applied-install-failed')
    assert.equal(result.results[0].verification.aligned, true, 'the manifest is still correct')
    assert.equal(entry.verification.installed, false)
  }
})

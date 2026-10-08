/**
 * Core tests: name grammars, manifest classification, plan computation,
 * rendering, locks, and atomic writes.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  acquireManifestLock,
  collectCandidates,
  isLocalSpecifier,
  isProductBundle,
  isSafePackageName,
  isSafeProfileName,
  listProfiles,
  loadProfile,
  planSync,
  productBundles,
  renderNextManifest,
  requireAbsolutePath,
  resolveDshHome,
  syncableBundles,
  verifyProfile,
  verifyTarget,
  writeManifestAtomic,
} from '../lib/sync-core.js'
import {
  PRODUCT_PREFIX,
  desktopManifest,
  makeHome,
  markInstalled,
  readManifest,
  webManifest,
  writeProfile,
} from './helpers.mjs'

test('resolveDshHome honours DSH_HOME and falls back to the home directory', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/custom-dsh' }), resolve('/tmp/custom-dsh'))
  assert.equal(resolveDshHome({ HOME: '/home/tester' }), join(resolve('/home/tester'), '.dsh'))
  assert.throws(() => resolveDshHome({}), /cannot determine DSH home/u)
})

test('package and profile name grammars reject traversal and junk', () => {
  assert.equal(isSafePackageName('dsh-find-plugin'), true)
  assert.equal(isSafePackageName('@scope/pkg-name'), true)
  assert.equal(isSafePackageName('../../etc/passwd'), false)
  assert.equal(isSafePackageName('Uppercase'), false)
  assert.equal(isSafePackageName(''), false)
  assert.equal(isSafeProfileName('web'), true)
  assert.equal(isSafeProfileName('../escape'), false)
  assert.equal(isSafeProfileName('..'), false)
  assert.equal(isSafeProfileName('a/b'), false)
  assert.equal(isSafeProfileName(7), false)
})

test('requireAbsolutePath accepts drive letters and UNC but rejects relative paths', () => {
  assert.equal(requireAbsolutePath('p', 'C:\\DSH home'), resolve('C:\\DSH home'))
  assert.equal(requireAbsolutePath('p', '\\\\server\\share'), resolve('\\\\server\\share'))
  assert.equal(requireAbsolutePath('p', '/var/lib/dsh'), resolve('/var/lib/dsh'))
  assert.throws(() => requireAbsolutePath('p', 'relative/path'), /absolute path/u)
  assert.throws(() => requireAbsolutePath('p', ''), /absolute path/u)
})

test('listProfiles finds manifests and ignores stray directories', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  mkdirSync(join(home, 'profiles', 'no-manifest'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'loose-file'), 'not a profile\n')
  assert.deepEqual(listProfiles(home), ['desktop', 'web'])
  assert.deepEqual(listProfiles(join(home, 'missing')), [])
})

test('loadProfile classifies product, user, desktop-owned and unknown bundles', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', {
    name: 'p',
    dependencies: { 'dsh-find-plugin': '0.4.0' },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          'dsh-find-plugin',
          'dsh-plugin-desktop',
          'installed-but-undeclared',
          'declared-but-absent',
        ],
      },
    },
  })
  markInstalled(home, 'web', 'installed-but-undeclared')
  const profile = loadProfile(home, 'web')
  assert.ok(profile)
  const kinds = Object.fromEntries(profile.bundles.map(bundle => [bundle.name, bundle.kind]))
  assert.equal(kinds['@deepseek-ai/dsh-base'], 'product')
  assert.equal(kinds['dsh-find-plugin'], 'user')
  assert.equal(kinds['dsh-plugin-desktop'], 'desktop-owned')
  assert.equal(kinds['installed-but-undeclared'], 'unknown')
  assert.equal(kinds['declared-but-absent'], 'unknown')
  assert.deepEqual(syncableBundles(profile), [{ name: 'dsh-find-plugin', spec: '0.4.0' }])
})

test('loadProfile refuses a malformed manifest instead of guessing', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', { name: 'p', dependencies: { 'dsh-x': '1.0.0' }, dsh: { profile: { bundles: ['dsh-x', 'dsh-x'] } } })
  assert.throws(() => loadProfile(home, 'web'), /repeats/u)

  writeProfile(home, 'broken', { name: 'p', dependencies: { '../../evil': '1.0.0' } })
  assert.throws(() => loadProfile(home, 'broken'), /invalid dependency name/u)
})

test('a manifest written with a UTF-8 BOM is still readable', (t) => {
  const home = makeHome(t)
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `\uFEFF${JSON.stringify(webManifest(), undefined, 2)}\n`)
  const profile = loadProfile(home, 'web')
  assert.ok(profile)
  assert.equal(profile.dependencies['dsh-find-plugin'], '0.4.0')
  assert.deepEqual(listProfiles(home), ['web'])
})

test('collectCandidates takes the union and reports specifier conflicts', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', {
    name: 'p',
    dependencies: { 'dsh-find-plugin': '0.4.0', 'shared-plugin': '1.0.0' },
    dsh: { profile: { bundles: [...PRODUCT_PREFIX, 'dsh-find-plugin', 'shared-plugin'] } },
  })
  writeProfile(home, 'work', {
    name: 'p',
    dependencies: { 'other-plugin': '^2.0.0', 'shared-plugin': '0.9.0' },
    dsh: { profile: { bundles: [...PRODUCT_PREFIX, 'other-plugin', 'shared-plugin'] } },
  })
  const { candidates, conflicts } = collectCandidates([
    loadProfile(home, 'web'),
    loadProfile(home, 'work'),
  ])
  assert.deepEqual(candidates.map(candidate => candidate.name), ['dsh-find-plugin', 'other-plugin', 'shared-plugin'])
  assert.deepEqual(conflicts, [{
    name: 'shared-plugin',
    specs: [{ from: 'web', spec: '1.0.0' }, { from: 'work', spec: '0.9.0' }],
  }])
  assert.equal(candidates.find(candidate => candidate.name === 'shared-plugin').from, 'web')
})

test('planSync adds only user bundles and never a product bundle', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })

  assert.equal(plan.candidates.length, 3)
  const desktop = plan.targets[0]
  assert.equal(desktop.aligned, false)
  assert.deepEqual(
    desktop.steps.map(step => step.name),
    ['@noob-stupid/dsh-plugin-console', 'dsh-find-plugin', 'dshmarket'],
  )
  const desktopBundles = desktop.steps.map(step => step.name)
  for (const product of productBundles()) assert.equal(desktopBundles.includes(product), false)
  assert.ok(plan.skipped.some(entry => entry.name === '@deepseek-ai/dsh-base' && entry.reason === 'product'))
})

test('a second plan after an apply is a no-op, and rendering is repeatable', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  const profile = loadProfile(home, 'desktop')
  const first = renderNextManifest(profile, plan.targets[0], '2026-01-01T00:00:00.000Z')
  const second = renderNextManifest(profile, plan.targets[0], '2026-01-01T00:00:00.000Z')
  assert.equal(first.text, second.text, 'rendering must not mutate the loaded profile')

  writeManifestAtomic(profile.manifestPath, first.text, { backup: false })
  const replan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  assert.equal(replan.targets[0].aligned, true)
  assert.equal(replan.targets[0].steps.length, 0)
  assert.equal(replan.restartRequired, false)
})

test('prune removes user bundles the sources do not have, and never a product bundle', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', {
    name: 'p',
    dependencies: { 'stale-plugin': '1.0.0' },
    dsh: { profile: { bundles: [...PRODUCT_PREFIX, 'stale-plugin'] } },
  })
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'], prune: true })
  const removals = plan.targets[0].steps.filter(step => step.action === 'remove').map(step => step.name)
  assert.deepEqual(removals, ['stale-plugin'])
  const profile = loadProfile(home, 'desktop')
  const rendered = renderNextManifest(profile, plan.targets[0], '2026-01-01T00:00:00.000Z')
  const next = JSON.parse(rendered.text)
  assert.equal(next.dsh.profile.bundles.includes('stale-plugin'), false)
  assert.equal(Object.hasOwn(next.dependencies, 'stale-plugin'), false)
  assert.deepEqual(next.dsh.profile.bundles.slice(0, 2), PRODUCT_PREFIX)
})

test('verifyTarget and verifyProfile report what is still missing', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  const verification = verifyTarget(home, plan.targets[0])
  assert.equal(verification.aligned, false)
  assert.equal(verification.declared, 0, 'the target declares nothing yet')
  assert.equal(verification.missingBundles.length, 3)
  assert.deepEqual(verification.missingPackages, [])

  // Profile-level verification is independent of any plan.
  assert.equal(verifyProfile(home, 'desktop').present, true)
  assert.deepEqual(verifyProfile(home, 'desktop').declared, [])
  const web = verifyProfile(home, 'web')
  assert.equal(web.missingPackages.length, 3, 'web declares three bundles it has not installed')
  assert.equal(web.declared.length, 3)
  assert.equal(verifyProfile(home, 'nope').present, false)

  // Once the target declares the bundles, an empty `node_modules` is visible.
  for (const step of plan.targets[0].steps) markInstalled(home, 'desktop', step.name)
  const after = verifyTarget(home, plan.targets[0])
  assert.equal(after.aligned, false, 'the manifest still has not been written')

  // A profile that declares bundles it cannot load is not installed.
  const broken = makeHome(t)
  writeProfile(broken, 'web', webManifest())
  const declared = planSync({ dshHome: broken, sources: ['web'], targets: ['web'] })
  const selfCheck = verifyTarget(broken, declared.targets[0])
  assert.equal(selfCheck.aligned, true)
  assert.equal(selfCheck.declared, 3)
  assert.equal(selfCheck.installed, false)
  assert.equal(selfCheck.missingPackages.length, 3)
})

test('conflicting sources are refused by default and never silently resolved', (t) => {
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

  assert.throws(
    () => planSync({ dshHome: home, sources: ['web', 'work'], targets: ['desktop'], strict: true }),
    /sources disagree on 1 bundle/u,
  )
  const loose = planSync({ dshHome: home, sources: ['web', 'work'], targets: ['desktop'] })
  assert.equal(loose.conflicts.length, 1)
  assert.equal(loose.strict, false)
})

test('local file specifiers are reported because they retarget on copy', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', {
    name: 'p',
    dependencies: { 'local-plugin': 'file:../local-plugin', 'registry-plugin': '^2.0.0' },
    dsh: { profile: { bundles: [...PRODUCT_PREFIX, 'local-plugin', 'registry-plugin'] } },
  })
  writeProfile(home, 'desktop', desktopManifest())
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  assert.deepEqual(plan.localSpecs.map(entry => entry.name), ['local-plugin'])
  assert.equal(isLocalSpecifier('file:../x'), true)
  assert.equal(isLocalSpecifier('link:./y'), true)
  assert.equal(isLocalSpecifier('portal:../z'), true)
  assert.equal(isLocalSpecifier('C:\\plugins\\z'), true)
  assert.equal(isLocalSpecifier('^1.0.0'), false)
  assert.equal(isLocalSpecifier('1.0.0'), false)
})

test('the manifest lock is exclusive and reclaims a stale lock', (t) => {
  const home = makeHome(t)
  const dir = writeProfile(home, 'desktop', desktopManifest())
  const manifestPath = join(dir, 'package.json')
  const release = acquireManifestLock(manifestPath, { timeoutMs: 200, staleMs: 60_000 })
  assert.throws(
    () => acquireManifestLock(manifestPath, { timeoutMs: 200, staleMs: 60_000 }),
    /timed out waiting/u,
  )
  release()
  const release2 = acquireManifestLock(manifestPath, { timeoutMs: 200, staleMs: 0 })
  release2()
})

test('a failed manifest write leaves the original manifest byte-identical', (t) => {
  const home = makeHome(t)
  const dir = writeProfile(home, 'desktop', desktopManifest())
  const manifestPath = join(dir, 'package.json')
  const before = readFileSync(manifestPath, 'utf8')
  // A directory at the temporary path makes the atomic replace fail after the
  // backup copy, which is the widest window in the write.
  mkdirSync(`${manifestPath}.profilesync.${process.pid.toString()}.tmp`, { recursive: true })
  assert.throws(() => writeManifestAtomic(manifestPath, '{}\n', { backup: false }))
  assert.equal(readFileSync(manifestPath, 'utf8'), before)
})

test('isProductBundle covers both local and 0.1.7-era product bundles', () => {
  assert.equal(isProductBundle('@deepseek-ai/dsh-base'), true)
  assert.equal(isProductBundle('@deepseek-ai/dsh-web-app'), true)
  assert.equal(isProductBundle('@deepseek-ai/dsh-desktop-app'), true)
  assert.equal(isProductBundle('dshmarket'), false)
})

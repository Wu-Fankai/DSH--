/**
 * CLI tests: argument parsing, profile-set resolution, exit codes, and the
 * guarantee that a dry run never writes.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { main, parseArgs, renderPlan, resolveProfileSets } from '../lib/cli.js'
import { planSync, verifyTarget } from '../lib/sync-core.js'
import { desktopManifest, makeHome, markInstalled, readManifest, webManifest, writeProfile } from './helpers.mjs'

/**
 * Run the CLI with captured output.
 * @param {string[]} argv - arguments.
 * @returns {Promise<{code: number, out: string, err: string}>} the run result.
 */
async function run(argv) {
  const out = []
  const err = []
  const code = await main(argv, {
    env: {},
    stdout: text => out.push(text),
    stderr: text => err.push(text),
  })
  return { code, out: out.join(''), err: err.join('') }
}

test('parseArgs rejects unknown flags and conflicting modes', () => {
  assert.deepEqual(parseArgs(['--from', 'web,work', '--to', 'desktop', '--apply']).from, ['web', 'work'])
  assert.equal(parseArgs(['--dsh-home=C:\\dsh']).dshHome, 'C:\\dsh')
  assert.equal(parseArgs(['--no-install']).install, false)
  assert.equal(parseArgs(['--allow-conflicts']).allowConflicts, true)
  assert.equal(parseArgs([]).allowConflicts, false)
  assert.throws(() => parseArgs(['--nope']), /unknown argument/u)
  assert.throws(() => parseArgs(['--check', '--apply']), /mutually exclusive/u)
  assert.throws(() => parseArgs(['--from']), /requires a value/u)
})

test('resolveProfileSets defaults web -> desktop and --all covers everything', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  writeProfile(home, 'work', desktopManifest())
  assert.deepEqual(resolveProfileSets(parseArgs([]), home), { sources: ['web'], targets: ['desktop'] })
  assert.deepEqual(resolveProfileSets(parseArgs(['--from', 'desktop']), home), { sources: ['desktop'], targets: ['web'] })
  assert.deepEqual(
    resolveProfileSets(parseArgs(['--all']), home),
    { sources: ['desktop', 'web', 'work'], targets: ['desktop', 'web', 'work'] },
  )
})

test('a dry run writes nothing and --apply performs the sync', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const before = readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')

  const dry = await run(['--dsh-home', home])
  assert.equal(dry.code, 0)
  assert.match(dry.out, /Dry run\. Re-run with --apply/u)
  assert.equal(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8'), before)

  const check = await run(['--dsh-home', home, '--check'])
  assert.equal(check.code, 1, '--check must fail while a target is unaligned')
  assert.match(check.err, /not aligned/u)

  for (const name of ['dsh-find-plugin', '@noob-stupid/dsh-plugin-console', 'dshmarket']) {
    markInstalled(home, 'desktop', name)
  }
  const apply = await run(['--dsh-home', home, '--apply', '--no-install', '--no-backup'])
  assert.equal(apply.code, 0)
  assert.match(apply.out, /Restart DSH/u)
  assert.equal(readManifest(home, 'desktop').dependencies['dsh-find-plugin'], '0.4.0')

  assert.equal((await run(['--dsh-home', home, '--check'])).code, 0, '--check must pass once usable')
})

test('a manifest that is aligned but not installed is not reported as usable', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  // The source is already fully installed, so the only thing `--check` can
  // object to is the target.
  for (const plugin of ['dsh-find-plugin', '@noob-stupid/dsh-plugin-console', 'dshmarket']) {
    markInstalled(home, 'web', plugin)
  }
  // Write the target manifest but install nothing: the profile now declares
  // three bundles it cannot load, which must not read as success.
  await run(['--dsh-home', home, '--apply', '--no-install', '--no-backup'])
  const plan = planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] })
  const verification = verifyTarget(home, plan.targets[0])
  assert.equal(verification.aligned, true, 'the manifest is correct')
  assert.equal(verification.installed, false, 'but the packages are absent')

  const check = await run(['--dsh-home', home, '--check'])
  assert.equal(check.code, 1, '--check must fail while declared bundles are not installed')
  assert.match(check.err, /declared but not installed/u)

  // With installation disabled entirely, the manifest claim is all that is made.
  assert.equal((await run(['--dsh-home', home, '--check', '--no-install'])).code, 0)
})

test('conflicting sources are refused with exit 2 and --allow-conflicts overrides', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', {
    name: 'p',
    dependencies: { 'shared-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'shared-plugin'] } },
  })
  writeProfile(home, 'work', {
    name: 'p',
    dependencies: { 'shared-plugin': '0.9.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'shared-plugin'] } },
  })
  writeProfile(home, 'desktop', desktopManifest())

  const refused = await run(['--dsh-home', home, '--from', 'web,work', '--to', 'desktop'])
  assert.equal(refused.code, 2)
  assert.match(refused.err, /sources disagree/u)

  const allowed = await run(['--dsh-home', home, '--from', 'web,work', '--to', 'desktop', '--allow-conflicts'])
  assert.equal(allowed.code, 0)
  assert.match(allowed.out, /--allow-conflicts: first source wins/u)
})

test('cli --json emits the plan and a bad DSH home exits 2', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const json = await run(['--dsh-home', home, '--json'])
  assert.equal(json.code, 0)
  const plan = JSON.parse(json.out)
  assert.equal(plan.targets[0].name, 'desktop')

  const bad = await run(['--dsh-home', 'relative-home'])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /absolute path/u)

  const unknown = await run(['--nope'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.err, /unknown argument/u)

  const help = await run(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.out, /Exit codes:/u)
})

test('renderPlan names what it refuses to sync and what is local', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', {
    name: 'p',
    dependencies: { 'local-plugin': 'file:../local-plugin' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'local-plugin'] } },
  })
  writeProfile(home, 'desktop', desktopManifest())
  const text = renderPlan(planSync({ dshHome: home, sources: ['web'], targets: ['desktop'] }))
  assert.match(text, /Deliberately not synced:/u)
  assert.match(text, /@deepseek-ai\/dsh-base \(product\)/u)
  assert.match(text, /Local specifiers/u)
  assert.match(text, /\+ local-plugin {2}file:\.\.\/local-plugin/u)
})

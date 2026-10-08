/**
 * Host-face tests: profile resolution, service naming, and the guarantee that a
 * capability this plugin can live without never breaks a profile boot.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SERVICE_NAME,
  apply as applyHostPlugin,
  configuredProfiles,
  createProfileSyncService,
  inject,
  launchedProfile,
  name,
  resolveProfiles,
} from '../lib/index.js'
import { desktopManifest, makeHome, markInstalled, webManifest, writeProfile } from './helpers.mjs'

test('the plugin advertises a stable name and a namespaced service', () => {
  assert.equal(name, 'dsh-plugin-profile-sync')
  assert.equal(SERVICE_NAME, 'dshProfileSync')
  // `ctx.provide` throws on a duplicate name, so the published property carries
  // this package's prefix instead of a generic word.
  assert.match(SERVICE_NAME, /^dsh[A-Z]/u)
  assert.deepEqual([...inject], ['webServer'])
})

test('configured profiles and launcher facts are narrowed, not trusted', () => {
  assert.deepEqual(configuredProfiles('web'), ['web'])
  assert.deepEqual(configuredProfiles(['web', ' work ']), ['web', 'work'])
  assert.equal(configuredProfiles('  '), undefined)
  assert.equal(configuredProfiles(undefined), undefined)
  assert.equal(configuredProfiles([7, null]), undefined)
  assert.deepEqual(launchedProfile({ name: 'web', dir: '/x' }), { name: 'web', dir: '/x' })
  assert.equal(launchedProfile({ name: 'web' }), undefined)
  assert.equal(launchedProfile({ name: '  ', dir: '/x' }), undefined)
  assert.equal(launchedProfile(null), undefined)
  assert.equal(launchedProfile('web'), undefined)
})

test('host plugin resolves profiles from config first, then the launcher', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const ctx = {
    get: serviceName => (serviceName === 'profileContext' ? { name: 'web', dir: home } : undefined),
  }
  const resolved = resolveProfiles(ctx, { dshHome: home })
  assert.equal('error' in resolved, false)
  assert.deepEqual(resolved.sources, ['web'])
  assert.deepEqual(resolved.targets, ['desktop'])
  assert.equal(resolved.origin, 'profileContext')

  const configured = resolveProfiles(ctx, { from: 'desktop', to: 'web', dshHome: home })
  assert.deepEqual(configured.sources, ['desktop'])
  assert.equal(configured.origin, 'config')

  // The launcher naming a profile that does not exist under this home is a
  // refusal, not a licence to guess.
  const foreign = resolveProfiles(ctx, { dshHome: makeHome(t) })
  assert.match(foreign.error, /the launcher reported profile/u)

  const refused = resolveProfiles({ get: () => undefined }, { dshHome: home })
  assert.match(refused.error, /no source profile is configured/u)
})

test('a service that throws on read does not break profile resolution', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const ctx = { get: () => { throw new Error('service constructor failed') } }
  const resolved = resolveProfiles(ctx, { from: 'web', to: 'desktop', dshHome: home })
  assert.equal('error' in resolved, false)
  assert.deepEqual(resolved.sources, ['web'])
})

test('host plugin publishes a service whose plan matches the core plan', async (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  writeProfile(home, 'desktop', desktopManifest())
  const provided = new Map()
  const ctx = {
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    get: () => undefined,
    provide: (serviceName, value) => { provided.set(serviceName, value) },
  }
  applyHostPlugin(ctx, { from: 'web', to: 'desktop' })
  assert.equal(provided.has(SERVICE_NAME), true, 'the service must be published')
  const service = provided.get(SERVICE_NAME)
  assert.deepEqual(Object.keys(service).sort(), ['listProfiles', 'plan', 'sync'])

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const plan = service.plan()
    assert.deepEqual(plan.sources, ['web'])
    assert.deepEqual(plan.targets.map(target => target.name), ['desktop'])
    assert.equal(plan.targets[0].steps.length, 3)
    for (const step of plan.targets[0].steps) markInstalled(home, 'desktop', step.name)
    const result = await service.sync({ install: false })
    assert.equal(result.results[0].status, 'applied')
    assert.deepEqual(service.listProfiles(), ['desktop', 'web'])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('host plugin survives a duplicate service name and still exposes the capability', () => {
  // `ctx.provide` throws synchronously when the name is taken. A capability this
  // plugin can live without must never be why a profile fails to boot, so the
  // collision has to be caught rather than propagated.
  const warnings = []
  const ctx = {
    logger: { info: () => {}, warn: text => warnings.push(text) },
    get: () => undefined,
    provide: () => { throw new Error(`service "${SERVICE_NAME}" has been registered at <other>`) },
  }
  assert.doesNotThrow(() => applyHostPlugin(ctx, { from: 'web', to: 'desktop' }))
  assert.equal(typeof ctx[SERVICE_NAME].plan, 'function')
  assert.match(warnings.join(''), /could not publish/u)
})

test('host plugin degrades instead of throwing when provide is unavailable', () => {
  const ctx = { logger: { info: () => {} }, get: () => undefined, effect: (fn) => fn() }
  applyHostPlugin(ctx, { from: 'web', to: 'desktop' })
  assert.equal(typeof ctx[SERVICE_NAME].plan, 'function')
})

test('building the service never touches the filesystem beyond reads', (t) => {
  const home = makeHome(t)
  writeProfile(home, 'web', webManifest())
  const service = createProfileSyncService({ logger: { info: () => {} }, get: () => undefined }, {
    from: 'web',
    to: 'web',
    dshHome: home,
  })
  // Constructing the capability must not plan, write, or spawn anything.
  assert.equal(typeof service.sync, 'function')
  const plan = service.plan()
  assert.deepEqual(plan.sources, ['web'])
})

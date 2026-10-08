/**
 * Shared fixtures for the test suite.
 *
 * Every test builds a throwaway DSH home under the OS temp directory, so the
 * suite never reads or writes a real profile and needs no network.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A product prefix shared by every fixture profile. */
export const PRODUCT_PREFIX = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * Create a temporary DSH home, removed when the test ends.
 * @param {import('node:test').TestContext} t - active test context.
 * @returns {string} absolute DSH home.
 */
export function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profile-sync-'))
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  return home
}

/**
 * Write one profile manifest.
 * @param {string} home - DSH home.
 * @param {string} name - profile name.
 * @param {object} manifest - manifest body.
 * @returns {string} absolute profile directory.
 */
export function writeProfile(home, name, manifest) {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  return dir
}

/**
 * Mark a package as physically installed in a profile.
 * @param {string} home - DSH home.
 * @param {string} profile - profile name.
 * @param {string} packageName - package name.
 */
export function markInstalled(home, profile, packageName) {
  const dir = join(home, 'profiles', profile, 'node_modules', ...packageName.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{ "name": "fixture" }\n')
}

/**
 * Read one profile manifest back.
 * @param {string} home - DSH home.
 * @param {string} profile - profile name.
 * @returns {Record<string, any>} parsed manifest.
 */
export function readManifest(home, profile) {
  return JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
}

/** A web-shaped fixture: three user plugins plus a product prefix. */
export function webManifest() {
  return {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      'dsh-find-plugin': '0.4.0',
      '@noob-stupid/dsh-plugin-console': '0.5.9',
      'dshmarket': '^1.54.0',
    },
    dsh: {
      profile: {
        bundles: [...PRODUCT_PREFIX, 'dshmarket', '@noob-stupid/dsh-plugin-console', 'dsh-find-plugin'],
        patchReload: 'live',
      },
    },
  }
}

/** A desktop-shaped fixture: product bundles only. */
export function desktopManifest() {
  return {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...PRODUCT_PREFIX] } },
  }
}

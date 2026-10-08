#!/usr/bin/env node
/**
 * Install the packed tarball into a throwaway consumer and prove it works.
 *
 * `npm install <tarball>` would be the obvious check, but this environment's
 * execution policy blocks the `npm` shim, and the property that matters is
 * narrower than what npm would exercise: the archive must contain everything
 * the manifest references, the bin must run, and the host export must load. All
 * three are checked directly, with no dependency and no network.
 */

import { gunzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const ROOT = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const archive = join(ROOT, `dsh-plugin-profile-sync-${manifest.version}.tgz`)

try {
  statSync(archive)
} catch {
  process.stderr.write(`install-check: ${relative(ROOT, archive)} is missing; run scripts/check-pack.mjs first\n`)
  process.exit(2)
}

/**
 * Read every entry out of a gzipped tar archive.
 * @param {Buffer} tar - uncompressed tar bytes.
 * @returns {Map<string, Buffer>} archive path to contents.
 */
function readTar(tar) {
  const files = new Map()
  let offset = 0
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    if (name === '') break
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/u, '').trim()
    const size = Number.parseInt(sizeField, 8) || 0
    const type = header.subarray(156, 157).toString('utf8')
    offset += 512
    if (type === '0' || type === '') {
      files.set(name, tar.subarray(offset, offset + size))
    }
    offset += Math.ceil(size / 512) * 512
  }
  return files
}

const entries = readTar(gunzipSync(readFileSync(archive)))
const staging = mkdtempSync(join(tmpdir(), 'dsh-install-'))
const packageRoot = join(staging, 'node_modules', manifest.name)
let ok = true

/**
 * Report one assertion.
 * @param {string} label - what is being asserted.
 * @param {boolean} held - whether it held.
 * @param {string} [detail] - extra context on failure.
 */
function check(label, held, detail) {
  process.stdout.write(`${held ? 'ok  ' : 'FAIL'}  ${label}${held || detail === undefined ? '' : ` — ${detail}`}\n`)
  if (!held) ok = false
}

try {
  // 1. Unpack exactly as a package manager would: npm's `package/` prefix is
  //    replaced by `node_modules/<name>/`.
  for (const [name, bytes] of entries) {
    if (!name.startsWith('package/')) continue
    const target = join(packageRoot, name.slice('package/'.length))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }
  const shipped = [...entries.keys()].filter(name => name.startsWith('package/'))
  check('the archive unpacks into node_modules/<name>', shipped.length > 0)
  check('package.json survives the round trip', entries.has('package/package.json'))

  // 2. Every manifest reference resolves inside the installed tree.
  const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const referenced = [
    installed.main,
    installed.types,
    installed.bin['dsh-profile-sync'],
    installed.dsh.bundle.patch,
    ...Object.values(installed.exports).flatMap(value =>
      typeof value === 'object' ? [value.types, value.default] : [value]),
  ].filter(value => typeof value === 'string')
  const missing = referenced.filter(path => {
    try {
      statSync(join(packageRoot, path.replace(/^\.\//u, '')))
      return false
    } catch {
      return true
    }
  })
  check('every manifest reference exists after install', missing.length === 0, missing.join(', '))

  // 3. The bin actually runs from the installed location. Output is inherited
  //    rather than captured: some confined environments refuse a piped child, so
  //    anything that only needs the exit code uses `stdio: 'inherit'`.
  const binPath = join(packageRoot, installed.bin['dsh-profile-sync'])
  const binSource = readFileSync(binPath, 'utf8')
  check('the installed bin has a node shebang', binSource.split('\n')[0].startsWith('#!/usr/bin/env node'))
  check('the installed bin imports the shipped cli', binSource.includes("from '../lib/cli.js'"))
  process.stdout.write('--- installed bin --help ---\n')
  const help = spawnSync(process.execPath, [binPath, '--help'], { stdio: 'inherit' })
  process.stdout.write('--- end ---\n')
  check('the installed bin exits 0 on --help', help.status === 0, `status ${String(help.status)}`)

  // 4. The host export loads, which is what DSH does with a bundle row.
  const host = await import(pathToFileURL(join(packageRoot, installed.main)).href)
  check('the host export names the plugin', host.name === 'dsh-plugin-profile-sync')
  check('the host export publishes a namespaced service', host.SERVICE_NAME === 'dshProfileSync')
  check('the host export exposes apply()', typeof host.apply === 'function')

  // 5. The subpath exports resolve too.
  for (const [key, value] of Object.entries(installed.exports)) {
    if (typeof value !== 'object' || key.endsWith('.yml')) continue
    const module = await import(pathToFileURL(join(packageRoot, value.default.replace(/^\.\//u, ''))).href)
    check(`subpath ${key} exports something`, Object.keys(module).length > 0)
  }

  process.stdout.write(`\nconsumer: ${relative(ROOT, staging).split(sep).join('/')}\n`)
  process.stdout.write(`\n${ok ? 'PASS' : 'FAIL'} — the packed artifact ${ok ? 'installs and runs' : 'is broken'}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
process.exitCode = ok ? 0 : 1

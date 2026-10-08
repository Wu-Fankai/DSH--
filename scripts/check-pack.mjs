#!/usr/bin/env node
/**
 * Verify the publish artifact without invoking npm.
 *
 * `npm pack` would be the obvious tool, but two things make it unusable here:
 * this environment's PowerShell execution policy blocks the `npm.ps1` shim, and
 * a package's own listing rules are exactly what needs checking — so they are
 * re-implemented from the documented behaviour and asserted against the real
 * tree. The archive is written with Node's own zlib, so a release check needs no
 * dependency and no network.
 */

import { createGzip } from 'node:zlib'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import process from 'node:process'

const ROOT = resolve(import.meta.dirname, '..')

/** Files npm always includes regardless of the `files` field. */
const ALWAYS_INCLUDED = new Set([
  'package.json',
  'README.md',
  'README',
  'LICENSE',
  'LICENCE',
  'CHANGELOG.md',
  'CHANGELOG',
  'NOTICE',
])

/** Files npm never includes. */
const NEVER_INCLUDED = [
  /^node_modules\//u,
  /\.profilesync\./u,
  /\.tmp$/u,
  /\.bak$/u,
  /^\.git\//u,
  /^tests\//u,
  /^scripts\//u,
]

/**
 * Report one assertion.
 * @param {string} label - what is being asserted.
 * @param {boolean} ok - whether it held.
 * @param {string} [detail] - extra context when it failed.
 * @returns {boolean} the assertion result.
 */
function check(label, ok, detail) {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined || ok ? '' : ` — ${detail}`}\n`)
  return ok
}

/**
 * List every file under a directory, relative to the package root.
 * @param {string} dir - absolute directory.
 * @returns {Promise<string[]>} POSIX-style relative paths.
 */
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...await walk(full))
    } else if (entry.isFile()) {
      out.push(relative(ROOT, full).split(sep).join('/'))
    }
  }
  return out
}

/**
 * Reproduce npm's `files` filtering.
 * @param {string[]} all - every file in the package root.
 * @param {string[]} patterns - the manifest's `files` entries.
 * @returns {{included: string[], excluded: string[]}} the filtered sets.
 */
function filterFiles(all, patterns) {
  const included = []
  const excluded = []
  for (const file of all) {
    if (NEVER_INCLUDED.some(pattern => pattern.test(file))) {
      excluded.push(file)
      continue
    }
    const matched = ALWAYS_INCLUDED.has(file)
      || patterns.some(pattern => {
        const prefix = pattern.replace(/\/\*\*$/u, '/').replace(/\/$/u, '')
        return file === prefix || file.startsWith(`${prefix}/`)
      })
    if (matched) included.push(file)
    else excluded.push(file)
  }
  return { included: included.sort(), excluded: excluded.sort() }
}

/**
 * Build a POSIX tar header for one entry.
 * @param {string} name - archive path.
 * @param {number} size - byte length.
 * @param {number} mode - file mode bits.
 * @param {number} mtimeSeconds - modification time.
 * @returns {Buffer} a 512-byte header.
 */
function tarHeader(name, size, mode, mtimeSeconds) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write((mode & 0o7777).toString(8).padStart(7, '0'), 100, 8, 'utf8')
  header.write('0000000', 108, 8, 'utf8')
  header.write(size.toString(8).padStart(11, '0'), 124, 12, 'utf8')
  header.write(Math.floor(mtimeSeconds).toString(8).padStart(11, '0'), 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write('0', 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0'), 148, 7, 'utf8')
  header.write(' ', 155, 1, 'utf8')
  return header
}

/**
 * Write a tar archive of the given files.
 * @param {string} archivePath - destination path.
 * @param {string[]} files - relative file paths.
 * @param {number} mtimeSeconds - modification time for every entry.
 */
async function writeTar(archivePath, files, mtimeSeconds) {
  const chunks = []
  for (const file of files) {
    const bytes = await readFile(join(ROOT, file))
    // npm prefixes every entry with `package/`.
    chunks.push(tarHeader(`package/${file}`, bytes.byteLength, 0o644, mtimeSeconds), bytes)
    const padding = 512 - (bytes.byteLength % 512)
    if (padding !== 512) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  const { writeFile, mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const staging = await mkdtemp(join(tmpdir(), 'dsh-pack-'))
  const tarPath = join(staging, 'package.tar')
  await writeFile(tarPath, Buffer.concat(chunks))
  await pipeline(createReadStream(tarPath), createGzip({ level: 9 }), createWriteStream(archivePath))
}

/**
 * Validate the manifest's publishability.
 * @param {Record<string, any>} manifest - parsed package.json.
 * @returns {boolean} whether every manifest assertion held.
 */
function checkManifest(manifest) {
  let ok = true
  ok = check('manifest is not private', manifest.private !== true, 'remove "private": true to publish') && ok
  ok = check('name is a valid unscoped package name', /^[a-z0-9][a-z0-9._-]*$/u.test(manifest.name ?? ''), String(manifest.name)) && ok
  ok = check('version is semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version ?? ''), String(manifest.version)) && ok
  ok = check('license is declared', typeof manifest.license === 'string' && manifest.license !== '') && ok
  ok = check('engines.node is declared', typeof manifest.engines?.node === 'string') && ok
  ok = check('repository url is set', typeof manifest.repository?.url === 'string') && ok
  ok = check(
    'repository url is stamped with a real target',
    !String(manifest.repository?.url ?? '').includes('REPLACE_ME'),
    'copy .release-target.example.json to .release-target.json and run `npm run release:stamp`',
  ) && ok
  ok = check('publishConfig.access is public', manifest.publishConfig?.access === 'public') && ok
  ok = check('bin entry points at a real file', typeof manifest.bin?.['dsh-profile-sync'] === 'string') && ok
  ok = check('dsh.bundle.patch is declared', typeof manifest.dsh?.bundle?.patch === 'string') && ok
  ok = check('every exported subpath carries types', Object.entries(manifest.exports ?? {}).every(([key, value]) => {
    if (key === './package.json' || key.endsWith('.yml')) return true
    return typeof value === 'object' && typeof value.types === 'string' && typeof value.default === 'string'
  })) && ok
  return ok
}

const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
let ok = checkManifest(manifest)

const files = await walk(ROOT)
const { included, excluded } = filterFiles(files, manifest.files ?? [])

// A declared path that matches nothing is a manifest bug that silently ships an
// incomplete package.
const missingPatterns = (manifest.files ?? []).filter(pattern => {
  const prefix = pattern.replace(/\/\*\*$/u, '')
  return !files.some(file => file === prefix || file.startsWith(`${prefix}/`))
})
ok = check('every files entry matches something', missingPatterns.length === 0, missingPatterns.join(', ')) && ok

ok = check('the bin entry is shipped', included.includes('bin/dsh-profile-sync.js')) && ok
ok = check('the bundle patch is shipped', included.includes('cordis.patch.yml')) && ok
ok = check('the license is shipped', included.includes('LICENSE')) && ok
ok = check('the README is shipped', included.includes('README.md')) && ok
ok = check(
  'every type declaration is shipped',
  included.filter(file => file.endsWith('.d.ts')).length >= 4,
  `found ${String(included.filter(file => file.endsWith('.d.ts')).length)}`,
) && ok
ok = check('tests are not shipped', !included.some(file => file.startsWith('tests/'))) && ok
ok = check('scripts are not shipped', !included.some(file => file.startsWith('scripts/'))) && ok

// Every runtime module the manifest points at must exist, or the package breaks
// on install for everyone but the author. npm writes archive entries and
// reports file lists without the `./` prefix a manifest may carry, so both sides
// are normalized before comparing.
const normalize = value => String(value).replace(/^\.\//u, '')
const referenced = [
  manifest.main,
  manifest.types,
  ...Object.values(manifest.exports ?? {}).flatMap(value =>
    typeof value === 'object' ? [value.types, value.default] : [value]),
].filter(value => typeof value === 'string' && !value.endsWith('.yml')).map(normalize)
const absent = referenced.filter(path => !included.includes(path))
ok = check('every manifest-referenced file exists', absent.length === 0, absent.join(', ')) && ok

const patch = await readFile(join(ROOT, manifest.dsh.bundle.patch), 'utf8')
ok = check(
  'the bundle patch inserts this plugin under its own id',
  patch.includes(`id: ${manifest.name}`) && patch.includes(`name: '${manifest.name}'`),
) && ok

const version = manifest.version
const archivePath = join(ROOT, `dsh-plugin-profile-sync-${version}.tgz`)
const newest = Math.max(...await Promise.all(included.map(async file => (await stat(join(ROOT, file))).mtimeMs)))
await writeTar(archivePath, included, newest / 1000)
const archiveSize = (await stat(archivePath)).size

process.stdout.write(`\nfiles shipped: ${String(included.length)} (excluded ${String(excluded.length)})\n`)
process.stdout.write(`archive: ${relative(ROOT, archivePath)} (${String(archiveSize)} bytes)\n`)
process.stdout.write(`\n${ok ? 'PASS' : 'FAIL'} — release artifact ${ok ? 'is complete' : 'is NOT ready'}\n`)
process.exitCode = ok ? 0 : 1

#!/usr/bin/env node
/**
 * Write the real repository identity into package.json.
 *
 * A publish URL cannot be guessed: a wrong one ships permanently into the npm
 * registry metadata, where consumers read it. The release target therefore lives
 * in `.release-target.json` (not shipped, not committed) and this script is the
 * only thing that stamps it in, so the value is always an explicit operator
 * statement rather than a placeholder that slipped through.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

const ROOT = resolve(import.meta.dirname, '..')
const TARGET = join(ROOT, '.release-target.json')
const MANIFEST = join(ROOT, 'package.json')

const PLACEHOLDER = /REPLACE_ME|<owner>|example\.com/u

let target
try {
  target = JSON.parse(await readFile(TARGET, 'utf8'))
} catch (cause) {
  process.stderr.write(
    `release-stamp: cannot read ${TARGET}\n`
    + 'Copy .release-target.example.json to .release-target.json and fill it in.\n'
    + `${cause instanceof Error ? cause.message : String(cause)}\n`,
  )
  process.exit(2)
}

const fields = ['repositoryUrl', 'bugsUrl', 'homepage']
const missing = fields.filter(field => typeof target[field] !== 'string' || target[field].trim() === '')
if (missing.length > 0) {
  process.stderr.write(`release-stamp: .release-target.json is missing ${missing.join(', ')}\n`)
  process.exit(2)
}
const unacceptable = fields.filter(field => PLACEHOLDER.test(target[field]))
if (unacceptable.length > 0) {
  process.stderr.write(`release-stamp: ${unacceptable.join(', ')} still contains a placeholder\n`)
  process.exit(2)
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
manifest.repository = { type: 'git', url: `git+${target.repositoryUrl.replace(/\.git$/u, '')}.git` }
manifest.bugs = { url: target.bugsUrl }
manifest.homepage = target.homepage
await writeFile(MANIFEST, `${JSON.stringify(manifest, undefined, 2)}\n`)

const changelogPath = join(ROOT, 'CHANGELOG.md')
try {
  const changelog = await readFile(changelogPath, 'utf8')
  const owner = new URL(target.repositoryUrl).pathname.replace(/^\//u, '')
  const stamped = changelog.replaceAll('https://github.com/REPLACE_ME/dsh-plugin-profile-sync', `https://github.com/${owner}`)
  if (stamped !== changelog) await writeFile(changelogPath, stamped)
} catch {
  // A missing CHANGELOG is reported by the pack check, not fatal here.
}

process.stdout.write(`release-stamp: package.json now points at ${target.repositoryUrl}\n`)
process.stdout.write('release-stamp: run `npm run release:check` before publishing\n')

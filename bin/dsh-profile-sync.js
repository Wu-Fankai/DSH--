#!/usr/bin/env node
/** Executable entry point for `dsh-profile-sync`. */

import process from 'node:process'
import { main } from '../lib/cli.js'

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
  process.exitCode = 1
}

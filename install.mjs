#!/usr/bin/env node
/**
 * Install dsh-web-keepalive into a dsh profile.
 *
 * Copies this package into `<profile>/plugins/web-keepalive/` and adds one insert
 * row to that profile's `cordis.patch.yml` — the supported user patch layer, which
 * is applied after every bundle layer, so the row mounts on every start.
 *
 * Deliberately conservative:
 *   - copying is an idempotent overwrite, so re-running refreshes the plugin files;
 *   - an existing row is detected by search and left completely alone;
 *   - a missing row is APPENDED as text, so the file's formatting is never reflowed.
 *     Appending only means something for a top-level BLOCK sequence, so a flow-style
 *     file is detected and refused instead of being written broken.
 *
 * Usage (CLI):
 *   node install.mjs [--profile web] [--dsh-home <dir>] [--dry-run]
 *
 * @module dsh-web-keepalive/install
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const ROW_ID = 'web-keepalive'
const INSTALL_DIR_NAME = 'web-keepalive'
/** Path as it appears in the patch file: relative to the profile directory. */
const ROW_NAME = './plugins/' + INSTALL_DIR_NAME + '/lib/index.js'

const ROW_BLOCK = [
  '',
  '# Keeps the dsh Web GUI live channel (/api/remote.mux) warm so the Host heartbeat',
  '# cannot terminate it; see plugins/' + INSTALL_DIR_NAME + '/lib/client.js for the cause.',
  '- insert:',
  '    - id: ' + ROW_ID,
  '      name: "' + ROW_NAME + '"',
  '',
].join('\n')

const MANUAL_INSTRUCTIONS = [
  'Add this entry by hand, as an item of the top-level array in cordis.patch.yml:',
  '',
  '  - insert:',
  '    - id: ' + ROW_ID,
  '      name: "' + ROW_NAME + '"',
  '',
].join('\n')

/**
 * Decide whether the append form is safe for the text already in the patch file.
 * The append only means something for a top-level block sequence (items beginning
 * with `-`). An empty file is fine; a top-level flow sequence (`[ {...} ]`) is not,
 * because a following `- insert:` would be a YAML syntax error.
 * @param existing - current patch file text (possibly empty).
 * @returns `'append'` when appending is safe, otherwise `'unsupported'`.
 */
export function appendSafety(existing) {
  for (const raw of existing.split(/\r?\n/)) {
    const text = raw.trim()
    if (text === '' || text.startsWith('#') || text === '---') continue
    return text.startsWith('-') ? 'append' : 'unsupported'
  }
  return 'append'
}

/** Whether the patch text already names this row. */
export function hasRow(existing) {
  return new RegExp('(^|\\s)' + ROW_ID + '(\\s|$|:)').test(existing)
}

/**
 * Install the plugin into one profile.
 * @param options - `profile`, `dshHome`, `dryRun`, and an optional `log` sink.
 * @returns `{ ok, reason? }` — never throws for an expected refusal.
 */
export function install(options) {
  const log = options.log ?? ((line) => process.stdout.write(line + '\n'))
  const dshHome = resolve(options.dshHome ?? join(homedir(), '.dsh'))
  const profile = options.profile ?? 'web'
  const profileDir = join(dshHome, 'profiles', profile)
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const targetDir = join(profileDir, 'plugins', INSTALL_DIR_NAME)

  log('profile      : ' + profileDir)
  log('plugin target: ' + targetDir)
  log('patch file   : ' + patchFile)

  if (!existsSync(join(profileDir, 'package.json'))) {
    log('install: no dsh profile at ' + profileDir)
    log('         check --profile / --dsh-home, or add the row by hand (see README).')
    return { ok: false, reason: 'no-profile' }
  }

  if (options.dryRun === true) {
    log('files        : would be copied')
  } else {
    rmSync(targetDir, { recursive: true, force: true })
    mkdirSync(join(targetDir, 'lib'), { recursive: true })
    copyFileSync(join(PACKAGE_DIR, 'package.json'), join(targetDir, 'package.json'))
    copyFileSync(join(PACKAGE_DIR, 'lib', 'index.js'), join(targetDir, 'lib', 'index.js'))
    copyFileSync(join(PACKAGE_DIR, 'lib', 'client.js'), join(targetDir, 'lib', 'client.js'))
    log('files        : copied')
  }

  const existing = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''

  if (hasRow(existing)) {
    log('row          : already present, left completely alone')
    log('done. restart dsh for the row to mount.')
    return { ok: true, reason: 'already-present' }
  }

  if (appendSafety(existing) !== 'append') {
    log('row          : NOT added — ' + patchFile + ' does not start with a block sequence,')
    log('               so appending would produce invalid YAML. The file was left untouched.')
    log(MANUAL_INSTRUCTIONS)
    return { ok: false, reason: 'unsupported-shape' }
  }

  if (options.dryRun === true) {
    log('row          : would be appended')
    log('--- appended block (dry run) ---')
    log(ROW_BLOCK)
    return { ok: true, reason: 'dry-run' }
  }

  writeFileSync(patchFile, existing + ROW_BLOCK)
  log('row          : appended')
  log('done. restart dsh for the row to mount.')
  return { ok: true, reason: 'appended' }
}

function usage(message) {
  if (message !== undefined) process.stderr.write('install: ' + message + '\n')
  process.stderr.write('usage: node install.mjs [--profile <name>] [--dsh-home <dir>] [--dry-run]\n')
  process.exit(message === undefined ? 0 : 2)
}

function parseArgs(argv) {
  const options = { profile: 'web', dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'), dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--profile') options.profile = argv[++index] ?? ''
    else if (arg === '--dsh-home') options.dshHome = argv[++index] ?? ''
    else if (arg === '--help' || arg === '-h') usage()
    else usage('unknown argument ' + JSON.stringify(arg))
  }
  if (options.profile === '') usage('--profile needs a value')
  if (options.dshHome === '') usage('--dsh-home needs a value')
  return options
}

// Only run the CLI when executed directly, so the module stays importable in tests.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = install(parseArgs(process.argv.slice(2)))
  process.exit(result.ok ? 0 : 1)
}

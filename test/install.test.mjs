// Tests for install.mjs.
//
// The installer-behaviour checks below need nothing but Node. The strongest check —
// that the produced `cordis.patch.yml` is accepted by dsh's OWN patch parser — needs
// a dsh installation and is SKIPPED (loudly, not silently) when one is not found.
//
// Run: node test/install.test.mjs
// Point at a specific dsh install with: DSH_APP_BOOT=<abs path to dsh-app-boot/lib/index.js>
//                                        DSH_INSTALL_ANCHOR=<abs path to dsh/package.json>

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOT = join(REPO, '.test-tmp')
const HOME = join(ROOT, 'home')

const { install, appendSafety, hasRow } = await import(pathToFileURL(join(REPO, 'install.mjs')).href)

const INSTALL_ANCHOR =
  process.env.DSH_INSTALL_ANCHOR ?? 'D:/node.js/node_global/node_modules/@deepseek-ai/dsh/package.json'

/** Locate dsh's patch parser, or report that the check must be skipped. */
async function loadDshParser() {
  const candidates = []
  if (process.env.DSH_APP_BOOT !== undefined) candidates.push(process.env.DSH_APP_BOOT)
  candidates.push('D:/node.js/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const module = await import(pathToFileURL(candidate).href)
    return { loadProfile: module.loadProfile, anchor: INSTALL_ANCHOR }
  }
  return undefined
}

const dsh = await loadDshParser()

rmSync(ROOT, { recursive: true, force: true })

let failures = 0
let skipped = 0

function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : ' :: ' + detail))
  if (!ok) failures += 1
}

function skip(label, why) {
  console.log('SKIP  ' + label + ' :: ' + why)
  skipped += 1
}

/** Create a throwaway profile directory. */
function makeProfile(name, patchText) {
  const dir = join(HOME, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-' + name, dsh: { profile: { bundles: [] } } }, null, 2),
  )
  if (patchText !== null) writeFileSync(join(dir, 'cordis.patch.yml'), patchText)
  return dir
}

/** Run the installer, capturing its log lines. */
function run(profile, extra = {}) {
  const lines = []
  const result = install({ dshHome: HOME, profile, log: (line) => lines.push(line), ...extra })
  return { result, text: lines.join('\n') }
}

/** Assert dsh's own patch parser accepts a profile's patch file. */
function dshAccepts(name, expectedEntries) {
  const label = name + ': dsh patch parser accepts the file'
  if (dsh === undefined) return skip(label, 'no dsh installation found')
  try {
    const profile = dsh.loadProfile('dsh', name, dsh.anchor, HOME, { userLayer: true })
    check(label, profile.patches.length === expectedEntries.count, 'entries ' + String(profile.patches.length))
  } catch (error) {
    check(label, false, error.message)
  }
}

// ------------------------------------------------------------ unit: shape decisions
check('appendSafety(empty) = append', appendSafety('') === 'append')
check('appendSafety(comments only) = append', appendSafety('# hi\n\n') === 'append')
check('appendSafety(block) = append', appendSafety('- id: a\n') === 'append')
check('appendSafety(flow) = unsupported', appendSafety('[ { id: a } ]\n') === 'unsupported')
check('appendSafety(mapping) = unsupported', appendSafety('a: 1\n') === 'unsupported')
check('hasRow finds the row', hasRow('- id: web-keepalive\n') === true)
check('hasRow ignores a similar id', hasRow('- id: web-keepalive-extra\n') === false)

// ------------------------------------------------------------ block-style patch file
const blockPatch = [
  '# a comment',
  '- id: web-ui-ssh',
  '  name: "@linxin666/dsh-web-all/ssh"',
  '  disabled: false',
  '- id: web-ui-doctor',
  '  name: "@linxin666/dsh-web-all/doctor"',
  '  disabled: false',
  '',
].join('\n')
const p1 = makeProfile('blockcase', blockPatch)
const r1 = run('blockcase')
check('block: install reports ok', r1.result.ok === true, r1.result.reason)
check('block: existing rows preserved verbatim', readFileSync(join(p1, 'cordis.patch.yml'), 'utf8').startsWith(blockPatch))
check('block: row appended', readFileSync(join(p1, 'cordis.patch.yml'), 'utf8').includes('id: web-keepalive'))
check('block: files copied', existsSync(join(p1, 'plugins', 'web-keepalive', 'lib', 'client.js')))
dshAccepts('blockcase', { count: 3 })

// ------------------------------------------------------------ idempotence
const before = readFileSync(join(p1, 'cordis.patch.yml'), 'utf8')
const r2 = run('blockcase')
check('idempotent: reports ok', r2.result.ok === true, r2.result.reason)
check('idempotent: patch file unchanged', before === readFileSync(join(p1, 'cordis.patch.yml'), 'utf8'))
check('idempotent: reports already present', r2.text.includes('already present'))

// ------------------------------------------------------------ flow-style must be refused
const flowPatch = '[ { id: a, name: "x", disabled: false } ]\n'
const p3 = makeProfile('flowcase', flowPatch)
const r3 = run('flowcase')
check('flow: refuses with unsupported-shape', r3.result.ok === false && r3.result.reason === 'unsupported-shape', r3.result.reason)
check('flow: patch file left untouched', readFileSync(join(p3, 'cordis.patch.yml'), 'utf8') === flowPatch)
check('flow: prints manual instructions', r3.text.includes('- insert:'))

// ------------------------------------------------------------ no patch file yet
const p4 = makeProfile('emptycase', null)
const r4 = run('emptycase')
check('empty: reports ok', r4.result.ok === true, r4.result.reason)
check('empty: creates the patch file', readFileSync(join(p4, 'cordis.patch.yml'), 'utf8').includes('id: web-keepalive'))
dshAccepts('emptycase', { count: 1 })

// ------------------------------------------------------------ dry run changes nothing
const p5 = makeProfile('drycase', blockPatch)
const r5 = run('drycase', { dryRun: true })
check('dry-run: reports ok', r5.result.ok === true, r5.result.reason)
check('dry-run: patch file unchanged', readFileSync(join(p5, 'cordis.patch.yml'), 'utf8') === blockPatch)
check('dry-run: plugin files not copied', existsSync(join(p5, 'plugins')) === false)

// ------------------------------------------------------------ unknown profile
const r6 = run('nosuchprofile')
check('missing profile: refuses with no-profile', r6.result.ok === false && r6.result.reason === 'no-profile', r6.result.reason)

console.log('')
console.log(
  (failures === 0 ? 'ALL CHECKS PASSED' : String(failures) + ' CHECK(S) FAILED') +
    (skipped === 0 ? '' : ' (' + String(skipped) + ' skipped)'),
)
rmSync(ROOT, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)

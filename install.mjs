#!/usr/bin/env node
/**
 * dsh-plan-mode-enhanced — one-command installer.
 *
 *   node install.mjs [--profile <name>]
 *
 * Installs this plugin into a DeepSeek Harness profile:
 *   1. links the plugin into the profile's node_modules
 *      (Windows: junction, no admin needed; POSIX: symlink);
 *   2. appends the required cordis.patch.yml configuration
 *      (the plugin entry + the `permission` plan-mode preset table +
 *      `- id: plan-mode / disabled: false`), idempotently.
 *
 * Idempotent: safe to run repeatedly; already-installed parts are skipped,
 * so a second run never produces a duplicate loader entry (which would be a
 * hard boot failure). Works alongside a manual installation (junction +
 * insert already present → reports "already ready" and exits).
 *
 * Requirements: Node.js >= 14 (DeepSeek Harness itself requires Node >= 20).
 * No third-party dependencies.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, symlinkSync, realpathSync, lstatSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'dsh-plan-mode-enhanced'
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)))

const BANNER = [
  '',
  `  ${PLUGIN_NAME} installer`,
  '  ------------------',
  '',
].join('\n')

// ─────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────

function log(...args) {
  console.log(...args)
}

function fail(message) {
  console.error(`\n[install] ${message}`)
  process.exit(1)
}

/** Resolve the DSH home directory (DSH_HOME env wins, else ~/.dsh). */
function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') {
    return resolve(process.env.DSH_HOME)
  }
  return join(homedir(), '.dsh')
}

/** List profile names under <home>/profiles (directories only). */
function listProfiles(home) {
  const dir = join(home, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('.'))
}

/** Resolve the target profile directory; exits with a helpful message on failure. */
function resolveProfileDir(args, home) {
  const argIndex = args.indexOf('--profile')
  let name
  if (argIndex !== -1) {
    name = args[argIndex + 1]
    if (!name) fail('--profile requires a profile name, e.g. `node install.mjs --profile web`')
  }
  const profiles = listProfiles(home)
  if (!name) {
    // Auto-detect: desktop first, then web.
    name = profiles.includes('desktop') ? 'desktop' : profiles.includes('web') ? 'web' : undefined
    if (!name) {
      fail(
        `no profile found under ${join(home, 'profiles')} (found: ${profiles.length ? profiles.join(', ') : 'none'}).\n` +
        '  Create one first (e.g. `dsh --profile desktop`), or pass `--profile <name>`.'
      )
    }
    log(`[install] profile not specified — using "${name}" (detected).`)
  }
  const dir = join(home, 'profiles', name)
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
    fail(`profile "${name}" not found under ${join(home, 'profiles')} (found: ${profiles.join(', ') || 'none'}).`)
  }
  return { name, dir }
}

// ─────────────────────────────────────────────────────────────────────
// Step 1: link the plugin into the profile's node_modules
// ─────────────────────────────────────────────────────────────────────

function isSamePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function linkPlugin(profileDir) {
  const nmDir = join(profileDir, 'node_modules')
  const target = join(nmDir, PLUGIN_NAME)
  if (existsSync(target)) {
    const st = lstatSync(target)
    if (st.isSymbolicLink() || st.isDirectory()) {
      if (isSamePath(target, PLUGIN_DIR)) {
        log(`[install] link ok: node_modules/${PLUGIN_NAME} already points here (${PLUGIN_DIR}).`)
        return
      }
      fail(
        `node_modules/${PLUGIN_NAME} already exists but points elsewhere (${target}).\n` +
        `  Remove it first, then re-run this installer.`
      )
    }
    fail(`node_modules/${PLUGIN_NAME} exists but is not a link; remove it and re-run.`)
  }
  log(`[install] creating node_modules/${PLUGIN_NAME} -> ${PLUGIN_DIR}`)
  mkdirSync(nmDir, { recursive: true })
  try {
    // Windows: 'junction' needs no admin; POSIX ignores the type and makes a symlink.
    symlinkSync(PLUGIN_DIR, target, 'junction')
  } catch (error) {
    fail(
      `could not create the link (${error.message}).\n` +
      `  On Windows try: mklink /J "${target}" "${PLUGIN_DIR}"\n` +
      `  On macOS/Linux try: ln -s "${PLUGIN_DIR}" "${target}"`
    )
  }
}

// ─────────────────────────────────────────────────────────────────────
// Step 2: append the required cordis.patch.yml configuration (idempotent)
// ─────────────────────────────────────────────────────────────────────

const PATCH_SECTIONS = [
  {
    key: 'permission preset table',
    check: (text) =>
      /(^|\n)[ \t]*-[ \t]*id:[ \t]*permission\b/m.test(text) &&
      /(^|\n)[ \t]*plan-mode:[ \t]*(#.*)?$/m.test(text),
    block: `# Plan Mode permission preset (sandbox read-only + approval ask)
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      plan-mode:
        sandbox: read-only
        approval: ask
        name: Plan Mode
        description: Explore and design before presenting the complete plan through exit_plan_mode.
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
`,
  },
  {
    key: 'plan-mode re-enable',
    check: (text) => /(^|\n)[ \t]*-[ \t]*id:[ \t]*plan-mode[ \t]*$/m.test(text),
    block: `# The web-app bundle disables the plan-mode service by default; re-enable it
# so the bridge and the review card can use the planMode service.
- id: plan-mode
  disabled: false
`,
  },
  {
    key: 'plugin entry',
    check: (text) => text.includes(PLUGIN_NAME),
    block: `# dsh-plan-mode-enhanced: Plan Mode enhancement (permission-dropdown bridge + review card)
- insert:
    - id: plan-mode-enhanced
      name: 'dsh-plan-mode-enhanced'
`,
  },
]

function appendPatch(profileDir) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let text = ''
  if (existsSync(patchPath)) {
    text = readFileSync(patchPath, 'utf8')
  }
  const missing = PATCH_SECTIONS.filter((s) => !s.check(text))
  if (missing.length === 0) {
    log('[install] patch ok: cordis.patch.yml already contains all required configuration.')
    return
  }
  // Backup before changing, so the user can roll back.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${patchPath}.bak-install-${stamp}`
  writeFileSync(backupPath, text, 'utf8')
  log(`[install] backed up cordis.patch.yml -> ${backupPath}`)

  const additions = missing.map((s) => s.block).join('\n')
  // Keep a blank line between the existing content and the appended blocks.
  let next = text
  if (next.length > 0 && !next.endsWith('\n')) next += '\n'
  if (next.length > 0) next += '\n'
  next += additions
  writeFileSync(patchPath, next, 'utf8')
  for (const s of missing) {
    log(`[install] appended patch: ${s.key}`)
  }
}

// ─────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  log(`usage: node install.mjs [--profile <name>]`)
  log(`  --profile <name>   install into that profile under ~/.dsh/profiles (default: desktop, else web)`)
  log(`  --help             show this help`)
  process.exit(0)
}

log(BANNER)
const home = dshHome()
const { name: profileName, dir: profileDir } = resolveProfileDir(args, home)
log(`[install] plugin:      ${PLUGIN_DIR}`)
log(`[install] dsh home:    ${home}`)
log(`[install] profile:     ${profileName} (${profileDir})`)

linkPlugin(profileDir)
appendPatch(profileDir)

log('')
log(`[install] done. Restart DeepSeek Harness for the changes to take effect.`)
log(`[install] if the profile was running, quit it (or use its restart command) and start again.`)

#!/usr/bin/env node
// @ts-check
// skills-syncer — vendor Claude Code skills + agents from ANY catalog into your repo.
//
//   npx skills-syncer --from github:acme/our-skills --skill '*'
//   npx skills-syncer --from ./local-catalog --skill fsd-rules react-rules
//   npx skills-syncer --from github:acme/our-skills --skill run-maintain --agent worker
//   npx skills-syncer --from ./local-catalog --skill '*' --dry-run  # preview only
//   npx skills-syncer                              # re-sync using ./skills-syncer.json
//
// It copies REAL files (not symlinks) into the current repo:
//   ./.claude/skills/<name>/   <- each selected skill folder
//   ./.claude/agents/<role>.md <- each selected/required agent
//   ./AGENTS.md                <- the catalog's shared block, merged in (if present)
//   ./skills-syncer.json           <- your choice: source + selection (hand-editable)
//   ./skills-syncer-lock.json      <- generated manifest: per-item content hash
//
// The SOURCE is just a directory (local path or a github: repo) laid out as:
//   skills/<name>/   or  .claude/skills/<name>/     (auto-detected)
//   agents/<role>.md or  .claude/agents/<role>.md
//   skill-agents.json   (optional) maps a skill -> [agents it needs]
//   AGENTS.md           (optional) shared Project Instructions block
//
// Commit the result. Files are real copies, so nothing needs this tool at
// runtime — only the person adding or updating a skill runs the sync.

import {
  existsSync,
  rmSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, relative, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = process.cwd()

/**
 * @typedef {{ from?: string, skills?: string[], agents?: string[] }} Config
 *   Hand-editable intent file (skills-syncer.json): source + literal selection.
 * @typedef {Record<string, string[]>} Manifest  skill -> agents it requires
 * @typedef {{ hash: string }} SkillEntry
 * @typedef {{ hash: string, explicit: boolean, requiredBy: string[] }} AgentEntry
 * @typedef {{ version: number, source: string, skills: Record<string, SkillEntry>, agents: Record<string, AgentEntry> }} Lock
 *   Generated manifest (skills-syncer-lock.json): per-item content hash.
 * @typedef {{ root: string, cleanup: () => void }} Source
 */

// Markers that fence the shared block inside a repo's AGENTS.md.
const SHARED_BEGIN = '<!-- shared — managed by skills-syncer. Edit it in the source catalog, not here. -->'
const SHARED_END = '<!-- end shared. Put repo-specific notes below this line. -->'

// --- tiny CLI parser --------------------------------------------------------
// `--from X` takes one value; `--skill a b c` / `--agent a b c` take a list
// that runs until the next flag (a token starting with `-`, long or short).
// Each list accepts '*'. Skill/agent names never start with a dash.
/** @param {string[]} argv @param {string} flag @returns {string | null} */
function parseValueArg(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}
/** @param {string[]} argv @param {string} flag @returns {string[] | null} */
function parseListArg(argv, flag) {
  const i = argv.indexOf(flag)
  if (i === -1) return null
  const out = []
  for (let j = i + 1; j < argv.length; j++) {
    if (argv[j].startsWith('-')) break
    out.push(argv[j])
  }
  return out
}

// --- source resolution ------------------------------------------------------
// Returns { root, cleanup }. A `github:owner/repo[#ref]` source is shallow-cloned
// to a temp dir; a local path is used in place.
/** @param {string} from @returns {Source} */
function resolveSource(from) {
  if (from.startsWith('github:')) {
    const spec = from.slice('github:'.length)
    const [slug, ref] = spec.split('#')
    const dir = mkdtempSync(join(tmpdir(), 'skills-syncer-'))
    const url = `https://github.com/${slug}.git`
    const args = ['clone', '--depth', '1']
    if (ref) args.push('--branch', ref)
    args.push(url, dir)
    try {
      execFileSync('git', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      rmSync(dir, { recursive: true, force: true })
      const e = /** @type {{ stderr?: Buffer, message?: string }} */ (err)
      fail(`could not clone ${url}${ref ? ` (ref ${ref})` : ''}\n  ${String(e.stderr || e.message).trim()}`)
    }
    return { root: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }
  const root = resolve(from)
  if (!existsSync(root)) fail(`source path does not exist: ${root}`)
  return { root, cleanup: () => {} }
}

// Auto-detect where skills/agents live in the source.
/** @param {string} root @param {...string[]} candidates @returns {string} */
function pick(root, ...candidates) {
  for (const c of candidates) {
    const p = join(root, ...c)
    if (existsSync(p)) return p
  }
  return join(root, ...candidates[candidates.length - 1]) // default to last
}

// --- fs + hashing helpers ---------------------------------------------------
/** @param {string} dir @returns {string[]} */
function listDirs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
}
/** @param {string} dir @returns {string[]} */
function listAgents(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md'))
}
/** @param {string} dir @returns {string[]} */
function walkRel(dir) {
  /** @type {string[]} */
  const out = []
  /** @param {string} abs */
  const walk = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(relative(dir, p))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}
/** @param {string} dir @returns {string} */
function dirHash(dir) {
  const h = createHash('sha256')
  for (const rel of walkRel(dir)) {
    h.update(`${rel}\0`)
    h.update(readFileSync(join(dir, rel)))
  }
  return h.digest('hex')
}
/** @param {string} file @returns {string} */
function fileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
/** @param {string} p @returns {any} */
function readJson(p) {
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
// Write pretty JSON, but leave the file untouched if it already holds the same
// data. Keeps a re-sync a true no-op even when an external formatter (e.g. a
// repo's biome/prettier hook) rewrote the whitespace — no spurious git churn.
/** @param {string} p @param {any} obj @returns {void} */
function writeJsonStable(p, obj) {
  const next = JSON.stringify(obj)
  if (existsSync(p)) {
    try {
      if (JSON.stringify(JSON.parse(readFileSync(p, 'utf8'))) === next) return
    } catch {
      /* unreadable/!json — fall through and overwrite */
    }
  }
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`)
}
// Throw rather than process.exit, so the outer finally always runs cleanup
// (a github: source has a temp clone to remove).
class SyncError extends Error {}
/** @param {string} msg @returns {never} */
function fail(msg) {
  throw new SyncError(msg)
}

/** @returns {string} */
function readVersion() {
  const pkg = readJson(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))
  return (pkg && pkg.version) || '0.0.0'
}

// A catalog can *bundle* this tool: ship skills-syncer as its own `bin` so
// consumers run `npx github:owner/catalog --skill X` with no --from. When no
// source is given on the CLI or in skills-syncer.json, fall back to this tool's
// own package root if it carries a catalog.
/** @returns {string | null} the bundling package root, or null */
function bundledCatalogRoot() {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const hasCatalog = ['skills', '.claude/skills', 'agents', '.claude/agents'].some((p) =>
    existsSync(join(pkgRoot, ...p.split('/'))),
  )
  return hasCatalog ? pkgRoot : null
}
/** @param {string} pkgRoot @returns {string | null} */
function bundledName(pkgRoot) {
  const pkg = readJson(join(pkgRoot, 'package.json'))
  return (pkg && pkg.name) || null
}

const HELP = `skills-syncer — vendor Claude Code skills + agents from a catalog into your repo

Usage:
  skills-syncer --from <src> --skill <names…> [--agent <names…>]
  skills-syncer                      re-sync using ./skills-syncer.json
  skills-syncer --all [--root <dir>] re-sync every repo under a folder

Options:
  --from <src>      catalog source: github:owner/repo[#ref] or a local path
  --skill <names…>  skills to install ('*' = all in the catalog)
  --agent <names…>  agents to install directly ('*' = all); agents required
                    by a selected skill are pulled automatically
  --all             re-sync every immediate subfolder that has a
                    skills-syncer.json (each from its own recorded source)
  --root <dir>      with --all, the folder to scan (default: current dir)
  --dry-run, -n     show what would change; write nothing
  --help, -h        show this help
  --version, -v     print the version

Writes .claude/skills/, .claude/agents/, AGENTS.md, skills-syncer.json and
skills-syncer-lock.json into the current repo. Commit the result.`

const topArgv = process.argv.slice(2)
if (topArgv.includes('--help') || topArgv.includes('-h')) {
  console.log(HELP)
  process.exit(0)
}
if (topArgv.includes('--version') || topArgv.includes('-v')) {
  console.log(readVersion())
  process.exit(0)
}

// --- fleet mode: re-sync every repo under a folder --------------------------
// `--all` runs this same tool, bare, in each immediate subfolder that already
// has a skills-syncer.json — so each repo re-syncs from its OWN recorded source
// and selection. Different repos may point at different catalogs. `--dry-run`
// is passed through. Worktrees and nested repos are not reached (one level deep).
if (topArgv.includes('--all')) {
  const rootArg = parseValueArg(topArgv, '--root')
  const root = rootArg ? resolve(rootArg) : cwd
  const pass = topArgv.includes('--dry-run') || topArgv.includes('-n') ? ['--dry-run'] : []
  const self = fileURLToPath(import.meta.url)
  /** @type {string[]} */
  const ok = []
  /** @type {string[]} */
  const failed = []
  let skipped = 0
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const repo = join(root, e.name)
    if (!existsSync(join(repo, 'skills-syncer.json'))) {
      skipped++
      continue
    }
    console.log(`[skills-syncer] --all → ${e.name}`)
    const res = spawnSync(process.execPath, [self, ...pass], { cwd: repo, stdio: 'inherit' })
    if (res.status === 0) ok.push(e.name)
    else failed.push(e.name)
  }
  console.log(
    `[skills-syncer] --all: ${pass.length ? 'previewed' : 'synced'} ${ok.length} repo(s)` +
      `, skipped ${skipped} (no skills-syncer.json)` +
      (failed.length ? `, failed: ${failed.join(', ')}` : ''),
  )
  process.exit(failed.length ? 1 : 0)
}

// --- resolve source + selection ---------------------------------------------
let cleanup = () => {}
try {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run') || argv.includes('-n')
  const config = readJson(join(cwd, 'skills-syncer.json')) || {}

  const from = parseValueArg(argv, '--from') || config.from
  let bundled = false
  /** @type {string} the human label for the source, recorded in the lock */
  let sourceId
  let src
  if (from) {
    src = resolveSource(from)
    sourceId = from
  } else {
    const cat = bundledCatalogRoot()
    if (!cat) {
      fail('no source. pass --from <github:owner/repo | ./path>, or add it to skills-syncer.json.')
    }
    bundled = true
    src = { root: cat, cleanup: () => {} }
    sourceId = bundledName(cat) || 'bundled-catalog'
  }
  const root = src.root
  cleanup = src.cleanup

  const srcSkillsDir = pick(root, ['skills'], ['.claude', 'skills'])
  const srcAgentsDir = pick(root, ['agents'], ['.claude', 'agents'])
  const srcAgentsMd = join(root, 'AGENTS.md')
  const manifestPath = join(root, 'skill-agents.json')

  // Refuse to sync a local source into itself.
  if (resolve(root) === resolve(cwd)) fail('refusing to sync the source into itself')

  const availableSkills = listDirs(srcSkillsDir)
  const availableAgents = listAgents(srcAgentsDir)
  if (!availableSkills.length && !availableAgents.length) {
    fail(`no skills or agents found in source (looked in ${srcSkillsDir} and ${srcAgentsDir})`)
  }

  const rawManifest = readJson(manifestPath) || {}
  /** @type {Manifest} */
  const manifest = {}
  for (const [skill, agents] of Object.entries(rawManifest)) {
    if (!skill.startsWith('$')) manifest[skill] = agents // skip $comment et al.
  }

  // Literal selection: CLI wins, else config. Keep '*' literal so re-syncs stay dynamic.
  const argSkills = parseListArg(argv, '--skill')
  const argAgents = parseListArg(argv, '--agent')
  const skillLiteral = argSkills?.length ? argSkills : config.skills || []
  const agentLiteral = argAgents?.length ? argAgents : config.agents || []

  let skillSel = skillLiteral.includes('*') ? availableSkills.slice() : skillLiteral.slice()
  let agentSel = agentLiteral.includes('*') ? availableAgents.slice() : agentLiteral.slice()

  if (!skillSel.length && !agentSel.length) {
    fail('nothing to sync: no --skill/--agent given and skills-syncer.json has no selection.')
  }

  // Drop names missing from the source; warn so a typo or deletion is visible.
  /** @param {string[]} names @param {string[]} available @param {string} kind @returns {string[]} */
  const keepKnown = (names, available, kind) => {
    for (const n of names.filter((n) => !available.includes(n)))
      console.warn(`[skills-syncer] skip ${kind} "${n}": not in source (deleted or misspelled)`)
    return names.filter((n) => available.includes(n))
  }
  skillSel = keepKnown(skillSel, availableSkills, 'skill')
  const explicitAgents = new Set(keepKnown(agentSel, availableAgents, 'agent'))

  // Agents required by selected skills, via the manifest.
  /** @type {Map<string, string[]>} */
  const requiredBy = new Map()
  for (const skill of skillSel) {
    for (const role of manifest[skill] || []) {
      if (!availableAgents.includes(role)) {
        console.warn(`[skills-syncer] ${skill} requires agent "${role}" but it is not in source — skip`)
        continue
      }
      if (!requiredBy.has(role)) requiredBy.set(role, [])
      requiredBy.get(role)?.push(skill)
    }
  }
  const agentsToInstall = new Set([...explicitAgents, ...requiredBy.keys()])

  // --- install --------------------------------------------------------------
  const skillsDest = join(cwd, '.claude', 'skills')
  const agentsDest = join(cwd, '.claude', 'agents')
  /** @type {Lock | null} */
  const prevLock = readJson(join(cwd, 'skills-syncer-lock.json'))
  /** @type {Lock} */
  const lock = { version: 1, source: sourceId, skills: {}, agents: {} }

  for (const name of [...skillSel].sort()) {
    const src = join(srcSkillsDir, name)
    const dest = join(skillsDest, name)
    const prev = prevLock?.skills?.[name]
    // Never clobber a repo-authored skill: if it exists on disk but our lock did
    // not install it, it is the repo's own — skip it and say so.
    if (existsSync(dest) && !prev) {
      console.warn(`[skills-syncer] skip skill "${name}": .claude/skills/${name}/ exists but is not managed by skills-syncer (repo-authored). Remove it to vendor this skill.`)
      continue
    }
    // Our own copy, edited locally since last sync: about to be overwritten.
    if (prev && existsSync(dest) && dirHash(dest) !== prev.hash) {
      console.warn(`[skills-syncer] skill "${name}" was edited locally since last sync — ${dryRun ? 'would overwrite' : 'overwriting'}. Make the change in the source catalog instead.`)
    }
    if (!dryRun) {
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dest, { recursive: true })
      cpSync(src, dest, { recursive: true })
    }
    lock.skills[name] = { hash: dirHash(src) }
  }

  if (agentsToInstall.size && !dryRun) mkdirSync(agentsDest, { recursive: true })
  for (const role of [...agentsToInstall].sort()) {
    const src = join(srcAgentsDir, `${role}.md`)
    const dest = join(agentsDest, `${role}.md`)
    const prev = prevLock?.agents?.[role]
    if (existsSync(dest) && !prev) {
      console.warn(`[skills-syncer] skip agent "${role}": .claude/agents/${role}.md exists but is not managed by skills-syncer (repo-authored). Remove it to vendor this agent.`)
      continue
    }
    if (prev && existsSync(dest) && fileHash(dest) !== prev.hash) {
      console.warn(`[skills-syncer] agent "${role}" was edited locally since last sync — ${dryRun ? 'would overwrite' : 'overwriting'}. Make the change in the source catalog instead.`)
    }
    if (!dryRun) {
      rmSync(dest, { force: true })
      cpSync(src, dest)
    }
    lock.agents[role] = {
      hash: fileHash(src),
      explicit: explicitAgents.has(role),
      requiredBy: (requiredBy.get(role) || []).sort(),
    }
  }

  // --- cleanup: drop what is no longer selected -----------------------------
  /** @type {{ skills: string[], agents: string[] }} */
  const removed = { skills: [], agents: [] }
  for (const name of prevLock?.skills ? Object.keys(prevLock.skills) : []) {
    if (lock.skills[name]) continue
    const dest = join(skillsDest, name)
    if (existsSync(dest)) {
      if (!dryRun) rmSync(dest, { recursive: true, force: true })
      removed.skills.push(name)
    }
  }
  // Only agents OUR lock installed are eligible for removal — never a repo-authored one.
  for (const role of prevLock?.agents ? Object.keys(prevLock.agents) : []) {
    if (lock.agents[role]) continue
    const dest = join(agentsDest, `${role}.md`)
    if (existsSync(dest)) {
      if (!dryRun) rmSync(dest, { force: true })
      removed.agents.push(role)
    }
  }

  // --- shared AGENTS.md block -----------------------------------------------
  const wroteAgentsMd = syncAgentsMd(srcAgentsMd, dryRun)

  // --- persist config + lock ------------------------------------------------
  // A bundled catalog has no stable `from` to record (the path is an ephemeral
  // npx checkout), so the intent file keeps only the selection — a bare re-sync
  // falls back to the bundled catalog again.
  if (!dryRun) {
    const intent = bundled
      ? { skills: skillLiteral, agents: agentLiteral }
      : { from, skills: skillLiteral, agents: agentLiteral }
    writeJsonStable(join(cwd, 'skills-syncer.json'), intent)
    writeJsonStable(join(cwd, 'skills-syncer-lock.json'), lock)
  }

  // --- report ---------------------------------------------------------------
  const repo = basename(cwd)
  const nSkills = Object.keys(lock.skills).length
  const nAgents = Object.keys(lock.agents).length
  const verb = dryRun ? 'would sync' : 'synced'
  console.log(
    `[skills-syncer]${dryRun ? ' (dry-run)' : ''} ${verb} ${nSkills} skill(s)` +
      (nAgents ? ` + ${nAgents} agent(s)` : '') +
      (wroteAgentsMd ? ' + AGENTS.md' : '') +
      ` into ${repo} (from ${sourceId})`,
  )
  const rverb = dryRun ? 'would remove' : 'removed'
  if (removed.skills.length) console.log(`[skills-syncer] ${rverb} skills: ${removed.skills.join(', ')}`)
  if (removed.agents.length) console.log(`[skills-syncer] ${rverb} agents: ${removed.agents.join(', ')}`)
  if (dryRun) console.log('[skills-syncer] dry run — nothing written. Re-run without --dry-run to apply.')
} catch (err) {
  if (err instanceof SyncError) {
    console.error(`[skills-syncer] ${err.message}`)
    process.exitCode = 1
  } else {
    throw err
  }
} finally {
  cleanup()
}

// Put the shared block at the top of the repo's AGENTS.md, keeping repo-specific
// notes below it. Idempotent: re-running replaces only the fenced block.
/** @param {string} srcAgentsMd @param {boolean} dryRun @returns {boolean} */
function syncAgentsMd(srcAgentsMd, dryRun) {
  if (!existsSync(srcAgentsMd)) return false
  const shared = readFileSync(srcAgentsMd, 'utf8').trim()
  const block = `${SHARED_BEGIN}\n\n${shared}\n\n${SHARED_END}`
  const dest = join(cwd, 'AGENTS.md')

  let body
  if (!existsSync(dest)) {
    body = block
  } else {
    const cur = readFileSync(dest, 'utf8')
    const b = cur.indexOf(SHARED_BEGIN)
    const e = cur.indexOf(SHARED_END)
    if (b !== -1 && e !== -1) {
      body = cur.slice(0, b) + block + cur.slice(e + SHARED_END.length)
    } else {
      let rest = cur.trimStart()
      // Migrate a block fenced by DIFFERENT markers (e.g. an older tool's): if the
      // file opens with an HTML-comment fence wrapping exactly the shared text,
      // drop the whole fenced block so the new one does not duplicate it.
      rest = stripForeignFence(rest, shared)
      if (rest.startsWith(shared)) rest = rest.slice(shared.length)
      rest = rest.replace(/^\s+/, '')
      body = rest ? `${block}\n\n${rest}` : block
    }
  }
  if (!body.endsWith('\n')) body += '\n'
  if (!dryRun) writeFileSync(dest, body)
  return true
}

// If `text` opens with `<!-- … -->\n\n<shared>\n\n<!-- … -->` (any marker text),
// return it with that fenced block removed; otherwise return `text` unchanged.
// Lets us adopt a repo previously fenced by a different tool without duplicating.
/** @param {string} text @param {string} shared @returns {string} */
function stripForeignFence(text, shared) {
  if (!text.startsWith('<!--')) return text
  const open = text.indexOf('-->')
  if (open === -1) return text
  const inner = text.slice(open + 3).trimStart()
  if (!inner.startsWith(shared)) return text
  const afterShared = inner.slice(shared.length).trimStart()
  if (!afterShared.startsWith('<!--')) return text
  const close = afterShared.indexOf('-->')
  return close === -1 ? text : afterShared.slice(close + 3)
}

#!/usr/bin/env node
// @ts-check
// skills-syncer — vendor Claude Code skills + agents from ANY catalog into your repo.
//
//   npx skills-syncer --from github:acme/our-skills --skill '*'
//   npx skills-syncer --from ./local-catalog --skill fsd-rules react-rules
//   npx skills-syncer --from github:acme/our-skills --skill run-maintain --agent worker
//   npx skills-syncer --from ./local-catalog --skill '*' --dry-run  # preview only
//   npx skills-syncer                              # re-sync using ./skills-syncer.json
//   npx skills-syncer --all --root ~/code          # re-sync every repo under a folder
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
// A re-sync is incremental: an item whose content already matches the catalog is
// left untouched (its on-disk hash equals the source hash). What it does install
// is written atomically — a copy lands in a temp sibling and is renamed into
// place, so a failed copy never destroys an existing folder.
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
  renameSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, relative, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {{ from?: string, skills?: string[], agents?: string[] }} Config
 *   Hand-editable intent file (skills-syncer.json): source + literal selection.
 * @typedef {Record<string, string[]>} Manifest  skill -> agents it requires
 * @typedef {{ hash: string }} SkillEntry
 * @typedef {{ hash: string, explicit: boolean, requiredBy: string[] }} AgentEntry
 * @typedef {{ version: number, source: string, skills: Record<string, SkillEntry>, agents: Record<string, AgentEntry> }} Lock
 *   Generated manifest (skills-syncer-lock.json): per-item content hash.
 * @typedef {{ root: string, cleanup: () => void, sourceId: string, bundled: boolean }} Catalog
 *   A resolved source: where it lives, how to clean it up, its lock label.
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
// A `github:owner/repo[#ref]` source is shallow-cloned to a temp dir; a local
// path is used in place.
/** @param {string} from @returns {{ root: string, cleanup: () => void }} */
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

// Resolve a catalog from `--from`/config, or fall back to a bundled catalog (a
// repo that ships skills-syncer as its own bin). Returns a label for the lock.
/** @param {string | undefined} from @returns {Catalog} */
function resolveCatalog(from) {
  if (from) {
    const s = resolveSource(from)
    return { root: s.root, cleanup: s.cleanup, sourceId: from, bundled: false }
  }
  const cat = bundledCatalogRoot()
  if (!cat) fail('no source. pass --from <github:owner/repo | ./path>, or add it to skills-syncer.json.')
  return { root: cat, cleanup: () => {}, sourceId: bundledName(cat) || 'bundled-catalog', bundled: true }
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

// Atomically replace a directory: copy into a sibling temp first, so a failed
// copy never destroys an existing dest; then swap it in.
/** @param {string} src @param {string} dest @returns {void} */
function installDir(src, dest) {
  const tmp = `${dest}.skills-syncer-tmp`
  rmSync(tmp, { recursive: true, force: true })
  cpSync(src, tmp, { recursive: true }) // creates parents; if this throws, dest is untouched
  rmSync(dest, { recursive: true, force: true })
  renameSync(tmp, dest)
}
// Replace a file atomically (rename over an existing file is atomic on POSIX).
/** @param {string} src @param {string} dest @returns {void} */
function installFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.skills-syncer-tmp`
  cpSync(src, tmp)
  renameSync(tmp, dest)
}

// Throw rather than process.exit, so a caller's finally can run cleanup
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

// --- the sync itself --------------------------------------------------------
// Sync one repo (`cwd`) from a catalog. Prints its own warnings + a report line.
// `catalog` may be pre-resolved (the caller then owns its cleanup) — `--all`
// uses this to fetch a shared source once and reuse it across repos.
/**
 * @param {{ cwd: string, from?: string, skills: string[], agents: string[],
 *           dryRun: boolean, catalog?: Catalog }} o
 * @returns {void}
 */
function sync(o) {
  const { cwd, skills, agents, dryRun } = o
  const cat = o.catalog || resolveCatalog(o.from)
  try {
    const root = cat.root
    if (resolve(root) === resolve(cwd)) fail('refusing to sync the source into itself')

    const srcSkillsDir = pick(root, ['skills'], ['.claude', 'skills'])
    const srcAgentsDir = pick(root, ['agents'], ['.claude', 'agents'])
    const srcAgentsMd = join(root, 'AGENTS.md')
    const manifestPath = join(root, 'skill-agents.json')

    const availableSkills = listDirs(srcSkillsDir)
    const availableAgents = listAgents(srcAgentsDir)
    if (!availableSkills.length && !availableAgents.length) {
      fail(`no skills or agents found in source (looked in ${srcSkillsDir} and ${srcAgentsDir})`)
    }

    const rawManifest = readJson(manifestPath) || {}
    /** @type {Manifest} */
    const manifest = {}
    for (const [skill, ags] of Object.entries(rawManifest)) {
      if (!skill.startsWith('$')) manifest[skill] = ags // skip $comment et al.
    }

    // Expand '*' against the catalog; keep the literal selection for the intent file.
    let skillSel = skills.includes('*') ? availableSkills.slice() : skills.slice()
    let agentSel = agents.includes('*') ? availableAgents.slice() : agents.slice()
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

    const skillsDest = join(cwd, '.claude', 'skills')
    const agentsDest = join(cwd, '.claude', 'agents')
    /** @type {Lock | null} */
    const prevLock = readJson(join(cwd, 'skills-syncer-lock.json'))
    /** @type {Lock} */
    const lock = { version: 1, source: cat.sourceId, skills: {}, agents: {} }

    // --- install skills (incremental + atomic) --------------------------------
    for (const name of [...skillSel].sort()) {
      const srcDir = join(srcSkillsDir, name)
      const dest = join(skillsDest, name)
      const prev = prevLock?.skills?.[name]
      const exists = existsSync(dest)
      // Never clobber a repo-authored skill: on disk but not in our lock.
      if (exists && !prev) {
        console.warn(`[skills-syncer] skip skill "${name}": .claude/skills/${name}/ exists but is not managed by skills-syncer (repo-authored). Remove it to vendor this skill.`)
        continue
      }
      const srcHash = dirHash(srcDir)
      const destHash = exists ? dirHash(dest) : null
      if (prev && destHash !== null && destHash !== prev.hash) {
        console.warn(`[skills-syncer] skill "${name}" was edited locally since last sync — ${dryRun ? 'would overwrite' : 'overwriting'}. Make the change in the source catalog instead.`)
      }
      // Already in sync? leave it alone. Otherwise install it atomically.
      if (destHash !== srcHash && !dryRun) installDir(srcDir, dest)
      lock.skills[name] = { hash: srcHash }
    }

    // --- install agents -------------------------------------------------------
    for (const role of [...agentsToInstall].sort()) {
      const srcFile = join(srcAgentsDir, `${role}.md`)
      const dest = join(agentsDest, `${role}.md`)
      const prev = prevLock?.agents?.[role]
      const exists = existsSync(dest)
      if (exists && !prev) {
        console.warn(`[skills-syncer] skip agent "${role}": .claude/agents/${role}.md exists but is not managed by skills-syncer (repo-authored). Remove it to vendor this agent.`)
        continue
      }
      const srcHash = fileHash(srcFile)
      const destHash = exists ? fileHash(dest) : null
      if (prev && destHash !== null && destHash !== prev.hash) {
        console.warn(`[skills-syncer] agent "${role}" was edited locally since last sync — ${dryRun ? 'would overwrite' : 'overwriting'}. Make the change in the source catalog instead.`)
      }
      if (destHash !== srcHash && !dryRun) installFile(srcFile, dest)
      lock.agents[role] = {
        hash: srcHash,
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

    // --- shared AGENTS.md block + persisted state -----------------------------
    const wroteAgentsMd = syncAgentsMd(cwd, srcAgentsMd, dryRun)
    if (!dryRun) {
      // A bundled catalog has no stable `from` to record (its path is an
      // ephemeral npx checkout); the intent keeps only the selection.
      const intent = cat.bundled ? { skills, agents } : { from: o.from, skills, agents }
      writeJsonStable(join(cwd, 'skills-syncer.json'), intent)
      writeJsonStable(join(cwd, 'skills-syncer-lock.json'), lock)
    }

    // --- report ---------------------------------------------------------------
    const repoName = basename(cwd)
    const nSkills = Object.keys(lock.skills).length
    const nAgents = Object.keys(lock.agents).length
    const verb = dryRun ? 'would sync' : 'synced'
    console.log(
      `[skills-syncer]${dryRun ? ' (dry-run)' : ''} ${verb} ${nSkills} skill(s)` +
        (nAgents ? ` + ${nAgents} agent(s)` : '') +
        (wroteAgentsMd ? ' + AGENTS.md' : '') +
        ` into ${repoName} (from ${cat.sourceId})`,
    )
    const rverb = dryRun ? 'would remove' : 'removed'
    if (removed.skills.length) console.log(`[skills-syncer] ${rverb} skills: ${removed.skills.join(', ')}`)
    if (removed.agents.length) console.log(`[skills-syncer] ${rverb} agents: ${removed.agents.join(', ')}`)
    if (dryRun) console.log('[skills-syncer] dry run — nothing written. Re-run without --dry-run to apply.')
  } finally {
    if (!o.catalog) cat.cleanup()
  }
}

// --- fleet mode -------------------------------------------------------------
// Re-sync every immediate subfolder of `root` that has a skills-syncer.json,
// each from its OWN recorded source + selection. Repos are grouped by source so
// a shared catalog is fetched once, not once per repo.
/** @param {{ root: string, dryRun: boolean }} o @returns {number} exit code */
function runAll(o) {
  const { root, dryRun } = o
  const dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  const repos = dirs.filter((e) => existsSync(join(root, e.name, 'skills-syncer.json'))).map((e) => e.name)
  const skipped = dirs.length - repos.length

  /** @type {Map<string, { from: string | undefined, repos: string[] }>} */
  const groups = new Map()
  for (const name of repos) {
    /** @type {Config} */
    const cfg = readJson(join(root, name, 'skills-syncer.json')) || {}
    const key = cfg.from || '<bundled>'
    if (!groups.has(key)) groups.set(key, { from: cfg.from, repos: [] })
    groups.get(key)?.repos.push(name)
  }

  /** @type {string[]} */ const ok = []
  /** @type {string[]} */ const failed = []
  for (const grp of groups.values()) {
    const catalog = tryResolve(grp.from)
    if (!catalog) {
      for (const name of grp.repos) {
        console.error(`[skills-syncer] --all ✗ ${name}: source could not be resolved`)
        failed.push(name)
      }
      continue
    }
    try {
      for (const name of grp.repos) {
        /** @type {Config} */
        const cfg = readJson(join(root, name, 'skills-syncer.json')) || {}
        console.log(`[skills-syncer] --all → ${name}`)
        try {
          sync({ cwd: join(root, name), from: grp.from, skills: cfg.skills || [], agents: cfg.agents || [], dryRun, catalog })
          ok.push(name)
        } catch (err) {
          if (!(err instanceof SyncError)) throw err
          console.error(`[skills-syncer] ${err.message}`)
          failed.push(name)
        }
      }
    } finally {
      catalog.cleanup()
    }
  }

  console.log(
    `[skills-syncer] --all: ${dryRun ? 'previewed' : 'synced'} ${ok.length} repo(s)` +
      `, skipped ${skipped} (no skills-syncer.json)` +
      (failed.length ? `, failed: ${failed.join(', ')}` : ''),
  )
  return failed.length ? 1 : 0
}
// Resolve a catalog, or report + return null on a SyncError (so --all can carry on).
/** @param {string | undefined} from @returns {Catalog | null} */
function tryResolve(from) {
  try {
    return resolveCatalog(from)
  } catch (err) {
    if (!(err instanceof SyncError)) throw err
    console.error(`[skills-syncer] ${err.message}`)
    return null
  }
}

// --- AGENTS.md merge --------------------------------------------------------
// Put the shared block at the top of the repo's AGENTS.md, keeping repo-specific
// notes below it. Idempotent: re-running replaces only the fenced block.
/** @param {string} cwd @param {string} srcAgentsMd @param {boolean} dryRun @returns {boolean} */
function syncAgentsMd(cwd, srcAgentsMd, dryRun) {
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
      // First merge into a repo-authored AGENTS.md: drop a leading raw copy of
      // the shared text if present (so we don't duplicate it) and keep the rest
      // below our block. A block fenced by ANOTHER tool's markers is left as-is —
      // migrating off that tool means removing its block first (a one-time,
      // tool-specific step, not something this generic merge should guess at).
      let rest = cur.trimStart()
      if (rest.startsWith(shared)) rest = rest.slice(shared.length)
      rest = rest.replace(/^\s+/, '')
      body = rest ? `${block}\n\n${rest}` : block
    }
  }
  if (!body.endsWith('\n')) body += '\n'
  if (!dryRun && (!existsSync(dest) || readFileSync(dest, 'utf8') !== body)) writeFileSync(dest, body)
  return true
}

// --- CLI entry --------------------------------------------------------------
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

const VALUE_FLAGS = new Set(['--from', '--root']) // take exactly one value
const LIST_FLAGS = new Set(['--skill', '--agent']) // take a list until the next flag
const KNOWN_FLAGS = new Set([
  ...VALUE_FLAGS,
  ...LIST_FLAGS,
  '--all',
  '--dry-run',
  '-n',
  '--help',
  '-h',
  '--version',
  '-v',
])

// Reject unknown flags, stray positionals, and a value flag with no value — so a
// typo fails loudly instead of being silently ignored.
/** @param {string[]} argv @returns {void} */
function validateArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('-')) fail(`unexpected argument "${tok}". Run --help for usage.`)
    if (!KNOWN_FLAGS.has(tok)) fail(`unknown flag "${tok}". Run --help for usage.`)
    if (VALUE_FLAGS.has(tok)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) fail(`"${tok}" expects a value`)
      i++ // consume the value
    } else if (LIST_FLAGS.has(tok)) {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) i++ // consume the list
    }
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) return console.log(HELP)
  if (argv.includes('--version') || argv.includes('-v')) return console.log(readVersion())

  try {
    validateArgs(argv)
    const dryRun = argv.includes('--dry-run') || argv.includes('-n')

    if (argv.includes('--all')) {
      for (const f of ['--from', '--skill', '--agent'])
        if (argv.includes(f))
          console.warn(`[skills-syncer] --all ignores ${f}: each repo re-syncs from its own skills-syncer.json`)
      const rootArg = parseValueArg(argv, '--root')
      const root = rootArg ? resolve(rootArg) : process.cwd()
      if (!existsSync(root)) fail(`--root path does not exist: ${root}`)
      process.exitCode = runAll({ root, dryRun })
      return
    }
    if (argv.includes('--root')) console.warn('[skills-syncer] --root has no effect without --all')

    const cwd = process.cwd()
    /** @type {Config} */
    const config = readJson(join(cwd, 'skills-syncer.json')) || {}
    const from = parseValueArg(argv, '--from') || config.from
    const argSkills = parseListArg(argv, '--skill')
    const argAgents = parseListArg(argv, '--agent')
    const skills = argSkills?.length ? argSkills : config.skills || []
    const agents = argAgents?.length ? argAgents : config.agents || []
    sync({ cwd, from: from || undefined, skills, agents, dryRun })
  } catch (err) {
    if (err instanceof SyncError) {
      console.error(`[skills-syncer] ${err.message}`)
      process.exitCode = 1
    } else {
      throw err
    }
  }
}

main()

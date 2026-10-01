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
//   ./.claude/hooks/<file>     <- every hook in the catalog (--no-hooks opts out)
//   ./.claude/settings.json    <- the catalog's `hooks` block, merged in
//   ./AGENTS.md                <- the catalog's shared block, merged in (if present)
//   ./skills-syncer.json           <- your choice: source + selection (hand-editable)
//   ./skills-syncer-lock.json      <- generated manifest: per-item content hash
//
// A repo can take skills from more than one source. The top-level `from` is the
// MAIN source: it alone writes AGENTS.md, CLAUDE.md and the hooks. Each entry in
// the optional `sources` list of skills-syncer.json adds skills and agents only:
//   { "from": "github:acme/our-skills", "skills": ["*"],
//     "sources": [{ "from": "github:someone/skills#v2.0.0", "skills": ["emails"] }] }
// One name in two sources stops the sync. The lock records the commit of each
// github: source, so a re-sync can say when an upstream moved.
// The one exception is a same-repo symlink CLAUDE.md -> AGENTS.md, so Claude Code
// reads the shared instructions too. Its target sits in the same repo, so it
// still rides with git into worktrees and the sandbox (a cross-repo link would not).
// `--claude-import` writes a real CLAUDE.md holding `@AGENTS.md` instead, for
// hosts that do not follow symlinks; `--no-claude-link` writes no CLAUDE.md at
// all. Either choice is recorded in skills-syncer.json, so later re-syncs keep it.
//
// The SOURCE is just a directory (local path or a github: repo) laid out as:
//   skills/<name>/   or  .claude/skills/<name>/     (auto-detected)
//   agents/<role>.md or  .claude/agents/<role>.md
//   hooks/<file>     or  .claude/hooks/<file>       (optional) hook scripts
//   settings.json    or  .claude/settings.json      (optional) its `hooks` block
//   skill-agents.json   (optional) maps a skill -> [agents it needs]
//   AGENTS.md           (optional) shared Project Instructions block
//
// Hooks are NOT part of the skill selection. A hook is repo-wide wiring, not a
// document an agent loads, so every repo takes all of them or opts out entirely.
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
  symlinkSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, relative, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {boolean | 'symlink' | 'import'} ClaudeLink
 *   How CLAUDE.md points at AGENTS.md: a symlink (default), an `@AGENTS.md`
 *   import inside a real file, or nothing at all (`false`).
 * @typedef {{ from: string, skills?: string[], agents?: string[] }} ExtraSource
 *   One more source: skills and agents only, never the shared files.
 * @typedef {{ from?: string, skills?: string[], agents?: string[], claudeLink?: ClaudeLink,
 *             hooks?: boolean, sources?: ExtraSource[] }} Config
 *   Hand-editable intent file (skills-syncer.json): source + literal selection.
 *   `claudeLink` records a non-default CLAUDE.md choice (`false` or `"import"`).
 *   `hooks: false` opts the repo out of the catalog's hooks.
 *   `sources` lists extra sources beside the main one.
 * @typedef {Record<string, string[]>} Manifest  skill -> agents it requires
 * @typedef {{ hash: string, from?: string }} SkillEntry
 *   `from` is set only for an item from an extra source.
 * @typedef {{ hash: string, explicit: boolean, requiredBy: string[], from?: string }} AgentEntry
 * @typedef {{ hash: string }} HookEntry
 * @typedef {{ version: number, source: string, skills: Record<string, SkillEntry>,
 *             agents: Record<string, AgentEntry>, hooks: Record<string, HookEntry>,
 *             settingsHooks: string[], commits?: Record<string, string> }} Lock
 *   Generated manifest (skills-syncer-lock.json): per-item content hash.
 *   `commits` maps each github: source (without its #ref) to the commit it gave.
 *   `settingsHooks` lists the settings.json hook groups this tool installed, so a
 *   later sync can take them back out without touching the repo's own hooks.
 * @typedef {{ root: string, cleanup: () => void, sourceId: string, bundled: boolean,
 *             commit?: string }} Catalog
 *   A resolved source: where it lives, how to clean it up, its lock label, and
 *   for a github: source the commit it was cloned at.
 */

// Markers that fence the shared block inside a repo's AGENTS.md.
const SHARED_BEGIN = '<!-- shared — managed by skills-syncer. Edit it in the source catalog, not here. -->'
const SHARED_END = '<!-- end shared. Put repo-specific notes below this line. -->'

// --- tiny ANSI styling (zero deps) ------------------------------------------
// Honour NO_COLOR and only colour a real terminal; piping/CI stays plain so the
// output is greppable. Kept inline so the tool ships as a single file.
const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
/** @param {string} code @returns {(s: string | number) => string} */
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : `${s}`)
const c = {
  bold: sgr('1'),
  dim: sgr('2'),
  red: sgr('31'),
  green: sgr('32'),
  yellow: sgr('33'),
  cyan: sgr('36'),
}
const SYM = { ok: COLOR ? '✓' : 'OK', fail: COLOR ? '✗' : 'XX', skip: COLOR ? '·' : '-' }

// Human-readable summary of what a sync touched: "36 skills · 6 agents · AGENTS.md".
/** @param {{ nSkills: number, nAgents: number, nHooks?: number, wroteAgentsMd: boolean,
 *            claudeLink?: 'created' | 'fixed' | 'ok' | 'skipped' | 'removed' | 'off' | null,
 *            claudeMode?: 'symlink' | 'import' | 'off',
 *            removed: { skills: string[], agents: string[], hooks?: string[] } }} r @returns {string} */
function describe(r) {
  /** @param {number} n @param {string} w */
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  const parts = [plural(r.nSkills, 'skill')]
  if (r.nAgents) parts.push(plural(r.nAgents, 'agent'))
  if (r.nHooks) parts.push(plural(r.nHooks, 'hook'))
  if (r.wroteAgentsMd) parts.push('AGENTS.md')
  if (r.claudeLink === 'created' || r.claudeLink === 'fixed')
    parts.push(r.claudeMode === 'import' ? 'CLAUDE.md↝@AGENTS.md' : 'CLAUDE.md↝AGENTS.md')
  if (r.claudeLink === 'removed') parts.push(c.yellow('−CLAUDE.md'))
  let out = parts.join(c.dim(' · '))
  const nRemoved = r.removed.skills.length + r.removed.agents.length + (r.removed.hooks?.length || 0)
  if (nRemoved) out += `  ${c.yellow(`−${nRemoved} removed`)}`
  return out
}

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
/** @param {string} from @returns {{ root: string, cleanup: () => void, commit?: string }} */
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
    let commit
    try {
      commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      /* no commit to record — the sync itself still works */
    }
    return { root: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }), commit }
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
    return { root: s.root, cleanup: s.cleanup, sourceId: from, bundled: false, commit: s.commit }
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
// Pretty-print JSON the way prettier and biome do it: two-space indent, one key
// per line, and an array kept on ONE line while it fits the print width. Repos
// run their own formatter over these files, so matching that shape here is what
// keeps a formatter and a re-sync from rewriting each other's whitespace.
// Objects always break, which is also what those formatters keep.
const PRINT_WIDTH = 80

/** @param {any} v @param {number} col where the value starts on its first line
 *  @param {number} indent indent of the value's own closing bracket
 *  @param {number} tail chars printed after the value on its last line (a comma)
 *  @returns {string} */
function formatJson(v, col, indent, tail) {
  const inner = ' '.repeat(indent + 2)
  const pad = ' '.repeat(indent)
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    // Try one line first. Nested breaks make it impossible, so bail on any \n.
    const flat = v.map((item) => formatJson(item, 0, 0, 0))
    const oneLine = `[${flat.join(', ')}]`
    if (!oneLine.includes('\n') && col + oneLine.length + tail <= PRINT_WIDTH) return oneLine
    const items = v.map((item, i) =>
      inner + formatJson(item, inner.length, indent + 2, i === v.length - 1 ? 0 : 1),
    )
    return `[\n${items.join(',\n')}\n${pad}]`
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined)
    if (!keys.length) return '{}'
    const entries = keys.map((k, i) => {
      const head = `${inner}${JSON.stringify(k)}: `
      return head + formatJson(v[k], head.length, indent + 2, i === keys.length - 1 ? 0 : 1)
    })
    return `{\n${entries.join(',\n')}\n${pad}}`
  }
  return JSON.stringify(v)
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
  writeFileSync(p, `${formatJson(obj, 0, 0, 0)}\n`)
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

// --- per-source plan ----------------------------------------------------------
// What one source gives: its selection expanded and checked against what it
// holds, plus the agents its skills require. The main source and every extra
// source go through the same plan, so they behave the same way.
/**
 * @typedef {{ cat: Catalog, main: boolean, srcSkillsDir: string, srcAgentsDir: string,
 *             skills: string[], explicitAgents: Set<string>,
 *             requiredBy: Map<string, string[]>, agents: string[], changed: boolean }} Plan
 *   `changed` turns true when the sync installs a new or different item from
 *   this source. Only then does the lock take the source's new commit.
 * @param {Catalog} cat @param {string[]} skills @param {string[]} agents
 * @param {boolean} main true for the main source, false for an extra one
 * @returns {Plan}
 */
function planSource(cat, skills, agents, main) {
  const root = cat.root
  const srcSkillsDir = pick(root, ['skills'], ['.claude', 'skills'])
  const srcAgentsDir = pick(root, ['agents'], ['.claude', 'agents'])
  // An extra source names itself in every message; the main one never did.
  const of = main ? '' : ` ${cat.sourceId}`

  const availableSkills = listDirs(srcSkillsDir)
  const availableAgents = listAgents(srcAgentsDir)
  if (!availableSkills.length && !availableAgents.length) {
    fail(`no skills or agents found in source${of} (looked in ${srcSkillsDir} and ${srcAgentsDir})`)
  }

  const rawManifest = readJson(join(root, 'skill-agents.json')) || {}
  /** @type {Manifest} */
  const manifest = {}
  for (const [skill, ags] of Object.entries(rawManifest)) {
    if (!skill.startsWith('$')) manifest[skill] = ags // skip $comment et al.
  }

  // Expand '*' against the catalog; keep the literal selection for the intent file.
  const skillSel = skills.includes('*') ? availableSkills.slice() : skills.slice()
  const agentSel = agents.includes('*') ? availableAgents.slice() : agents.slice()
  if (!skillSel.length && !agentSel.length) {
    fail(
      main
        ? 'nothing to sync: no --skill/--agent given and skills-syncer.json has no selection.'
        : `nothing to sync from ${cat.sourceId}: its entry in "sources" selects no skill or agent.`,
    )
  }

  // Drop names missing from the source; warn so a typo or deletion is visible.
  /** @param {string[]} names @param {string[]} available @param {string} kind @returns {string[]} */
  const keepKnown = (names, available, kind) => {
    for (const n of names.filter((n) => !available.includes(n)))
      console.warn(`[skills-syncer] skip ${kind} "${n}": not in source${of} (deleted or misspelled)`)
    return names.filter((n) => available.includes(n))
  }
  const known = keepKnown(skillSel, availableSkills, 'skill')
  const explicitAgents = new Set(keepKnown(agentSel, availableAgents, 'agent'))

  // Agents required by selected skills, via the manifest.
  /** @type {Map<string, string[]>} */
  const requiredBy = new Map()
  for (const skill of known) {
    for (const role of manifest[skill] || []) {
      if (!availableAgents.includes(role)) {
        console.warn(`[skills-syncer] ${skill} requires agent "${role}" but it is not in source${of} — skip`)
        continue
      }
      if (!requiredBy.has(role)) requiredBy.set(role, [])
      requiredBy.get(role)?.push(skill)
    }
  }
  const toInstall = [...new Set([...explicitAgents, ...requiredBy.keys()])]
  return {
    cat, main, srcSkillsDir, srcAgentsDir, skills: known, explicitAgents, requiredBy, agents: toInstall,
    changed: false,
  }
}

// One name may come from one source only. Two sources that both ship a skill
// called "emails" would overwrite each other on every sync, so stop instead.
// An agent may arrive because a skill needs it, so the message says why it came.
/** @param {Plan[]} plans @returns {void} */
function checkClashes(plans) {
  for (const kind of /** @type {const} */ (['skills', 'agents'])) {
    /** @type {Map<string, Plan>} */
    const owner = new Map()
    for (const p of plans) {
      for (const name of p[kind]) {
        const other = owner.get(name)
        if (other === undefined) {
          owner.set(name, p)
          continue
        }
        if (kind === 'skills') {
          fail(`skill "${name}" comes from two sources: ${other.cat.sourceId} and ${p.cat.sourceId}. Select it in one of them only.`)
        }
        /** @param {Plan} q @returns {string} */
        const why = (q) =>
          q.explicitAgents.has(name)
            ? `${q.cat.sourceId} (selected)`
            : `${q.cat.sourceId} (required by ${(q.requiredBy.get(name) || []).map((n) => `"${n}"`).join(', ')})`
        fail(`agent "${name}" comes from two sources: ${why(other)} and ${why(p)}. Drop one of those skills, or select the agent in one source only.`)
      }
    }
  }
}

// The lock keys a commit by the source WITHOUT its #ref. So a move from
// `#v1.0.0` to `#v1.1.0` still reads as one source whose commit changed.
/** @param {string} sourceId @returns {string} */
const commitKey = (sourceId) => sourceId.split('#')[0]

// --- the sync itself --------------------------------------------------------
// Sync one repo (`cwd`) from a catalog. Prints its own warnings + a report line.
// `catalog` may be pre-resolved (the caller then owns its cleanup) — `--all`
// uses this to fetch a shared source once and reuse it across repos. `resolve`
// does the same for the extra sources.
/**
 * @typedef {{ repoName: string, nSkills: number, nAgents: number, nHooks: number,
 *             wroteAgentsMd: boolean,
 *             claudeLink: 'created' | 'fixed' | 'ok' | 'skipped' | 'removed' | 'off' | null,
 *             claudeMode: 'symlink' | 'import' | 'off',
 *             sourceId: string, moved: string[],
 *             removed: { skills: string[], agents: string[], hooks: string[] } }} SyncResult
 *   `moved` holds one line per source whose commit changed since the last sync.
 * @param {{ cwd: string, from?: string, skills: string[], agents: string[],
 *           sources?: ExtraSource[], claudeLink?: ClaudeLink, hooks?: boolean, dryRun: boolean,
 *           catalog?: Catalog, resolve?: (from: string) => Catalog, quiet?: boolean }} o
 * @returns {SyncResult}
 */
function sync(o) {
  const { cwd, skills, agents, dryRun, quiet } = o
  const claudeMode = claudeModeOf(o.claudeLink)
  const cat = o.catalog || resolveCatalog(o.from)
  /** @type {Catalog[]} extra catalogs this call resolved, so it must clean them up */
  const own = []
  try {
    const root = cat.root
    if (resolve(root) === resolve(cwd)) fail('refusing to sync the source into itself')
    // skills-syncer.json is edited by hand, so check its shape before use.
    if (o.sources !== undefined && !Array.isArray(o.sources)) fail('"sources" in skills-syncer.json must be a list.')
    const sources = o.sources || []

    const srcHooksDir = pick(root, ['hooks'], ['.claude', 'hooks'])
    const srcSettings = pick(root, ['settings.json'], ['.claude', 'settings.json'])
    const srcAgentsMd = join(root, 'AGENTS.md')
    // Hooks ride with the catalog, not with a per-skill selection: a hook is
    // repo-wide wiring, not a document an agent loads. A repo opts out instead.
    const hooksOn = o.hooks !== false

    /** @type {Plan[]} */
    const plans = [planSource(cat, skills, agents, true)]
    // One source twice would give two commits under one lock key, and every
    // name it ships would clash with itself. Ask for one entry instead.
    /** @type {Map<string, string>} */
    const seen = new Map([[commitKey(cat.sourceId), cat.sourceId]])
    sources.forEach((src, i) => {
      if (!src || typeof src.from !== 'string' || !src.from) {
        fail(`"sources" entry ${i + 1} in skills-syncer.json needs a "from".`)
      }
      for (const key of /** @type {const} */ (['skills', 'agents'])) {
        if (src[key] !== undefined && !Array.isArray(src[key])) {
          fail(`"sources" entry ${i + 1} in skills-syncer.json: "${key}" must be a list.`)
        }
      }
      const twin = seen.get(commitKey(src.from))
      if (twin !== undefined) fail(`source ${commitKey(src.from)} is listed twice: as ${twin} and ${src.from}. Keep one entry.`)
      seen.set(commitKey(src.from), src.from)
      /** @type {Catalog} */
      let extra
      if (o.resolve) extra = o.resolve(src.from)
      else {
        extra = resolveCatalog(src.from)
        own.push(extra)
      }
      if (resolve(extra.root) === resolve(cwd)) fail('refusing to sync the source into itself')
      plans.push(planSource(extra, src.skills || [], src.agents || [], false))
    })
    checkClashes(plans)

    const skillsDest = join(cwd, '.claude', 'skills')
    const agentsDest = join(cwd, '.claude', 'agents')
    /** @type {Lock | null} */
    const prevLock = readJson(join(cwd, 'skills-syncer-lock.json'))
    /** @type {Lock} */
    const lock = { version: 1, source: cat.sourceId, skills: {}, agents: {}, hooks: {}, settingsHooks: [] }

    // --- install skills (incremental + atomic) --------------------------------
    for (const p of plans) {
      // An item from an extra source records where it came from.
      const from = p.main ? {} : { from: p.cat.sourceId }
      for (const name of [...p.skills].sort()) {
        const srcDir = join(p.srcSkillsDir, name)
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
        if (prev?.hash !== srcHash || prev?.from !== from.from) p.changed = true
        lock.skills[name] = { hash: srcHash, ...from }
      }
    }

    // --- install agents -------------------------------------------------------
    for (const p of plans) {
      const from = p.main ? {} : { from: p.cat.sourceId }
      for (const role of [...p.agents].sort()) {
        const srcFile = join(p.srcAgentsDir, `${role}.md`)
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
        if (prev?.hash !== srcHash || prev?.from !== from.from) p.changed = true
        lock.agents[role] = {
          hash: srcHash,
          explicit: p.explicitAgents.has(role),
          requiredBy: (p.requiredBy.get(role) || []).sort(),
          ...from,
        }
      }
    }

    // --- install hook scripts -------------------------------------------------
    const hooksDest = join(cwd, '.claude', 'hooks')
    for (const rel of hooksOn ? walkRel(srcHooksDir) : []) {
      const srcFile = join(srcHooksDir, rel)
      const dest = join(hooksDest, rel)
      const prev = prevLock?.hooks?.[rel]
      const exists = existsSync(dest)
      if (exists && !prev) {
        console.warn(`[skills-syncer] skip hook "${rel}": .claude/hooks/${rel} exists but is not managed by skills-syncer (repo-authored). Remove it to vendor this hook.`)
        continue
      }
      const srcHash = fileHash(srcFile)
      const destHash = exists ? fileHash(dest) : null
      if (prev && destHash !== null && destHash !== prev.hash) {
        console.warn(`[skills-syncer] hook "${rel}" was edited locally since last sync — ${dryRun ? 'would overwrite' : 'overwriting'}. Make the change in the source catalog instead.`)
      }
      if (destHash !== srcHash && !dryRun) installFile(srcFile, dest)
      lock.hooks[rel] = { hash: srcHash }
    }

    // --- cleanup: drop what is no longer selected -----------------------------
    /** @type {{ skills: string[], agents: string[], hooks: string[] }} */
    const removed = { skills: [], agents: [], hooks: [] }
    for (const rel of prevLock?.hooks ? Object.keys(prevLock.hooks) : []) {
      if (lock.hooks[rel]) continue
      const dest = join(hooksDest, rel)
      if (existsSync(dest)) {
        if (!dryRun) rmSync(dest, { force: true })
        removed.hooks.push(rel)
      }
    }
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

    // --- wire the hooks into .claude/settings.json ----------------------------
    lock.settingsHooks = syncSettingsHooks(
      cwd,
      hooksOn ? srcSettings : null,
      prevLock?.settingsHooks || [],
      dryRun,
    )

    // --- the commit each github: source gave --------------------------------
    // A source keeps its old commit while nothing it gives has changed. A new
    // commit that only touched other files would rewrite the lock on every
    // sync, so the lock names the commit the current content came from.
    /** @type {Record<string, string>} */
    const commits = {}
    /** @type {string[]} */
    const moved = []
    for (const p of plans) {
      if (!p.cat.commit) continue
      const key = commitKey(p.cat.sourceId)
      const was = prevLock?.commits?.[key]
      if (was && !p.changed) {
        commits[key] = was
        continue
      }
      commits[key] = p.cat.commit
      if (was && was !== p.cat.commit) moved.push(`${key}: ${was.slice(0, 7)} → ${p.cat.commit.slice(0, 7)}`)
    }
    // Left out when empty, so a repo on local sources keeps its old lock shape.
    if (Object.keys(commits).length) lock.commits = commits

    // --- shared AGENTS.md block + persisted state -----------------------------
    // Only the main source writes the shared files. An extra source gives
    // skills and agents, never AGENTS.md, CLAUDE.md or hooks.
    const wroteAgentsMd = syncAgentsMd(cwd, srcAgentsMd, dryRun)
    // Mirror AGENTS.md as CLAUDE.md so Claude Code picks it up too — as a symlink
    // or as an `@AGENTS.md` import. When off, a link we made is taken back out.
    let claudeLink = null
    if (claudeMode === 'off') claudeLink = dropClaudeMdLink(cwd, dryRun)
    else if (wroteAgentsMd) claudeLink = syncClaudeMd(cwd, dryRun, claudeMode)
    if (!dryRun) {
      // A bundled catalog has no stable `from` to record (its path is an
      // ephemeral npx checkout); the intent keeps only the selection.
      // `claudeLink` is recorded whenever it is not the default, so the choice
      // survives a bare re-sync.
      const intent = {
        ...(cat.bundled ? {} : { from: o.from }),
        skills,
        agents,
        // 'symlink' is the default, so it is left out; the other two are recorded.
        ...(claudeMode === 'off' ? { claudeLink: false } : {}),
        ...(claudeMode === 'import' ? { claudeLink: 'import' } : {}),
        // Hooks are on by default, so only the opt-out is recorded.
        ...(hooksOn ? {} : { hooks: false }),
        // Extra sources are kept exactly as written, with their literal selection.
        ...(sources.length ? { sources } : {}),
      }
      writeJsonStable(join(cwd, 'skills-syncer.json'), intent)
      writeJsonStable(join(cwd, 'skills-syncer-lock.json'), lock)
    }

    // --- report ---------------------------------------------------------------
    /** @type {SyncResult} */
    const result = {
      repoName: basename(cwd),
      nSkills: Object.keys(lock.skills).length,
      nAgents: Object.keys(lock.agents).length,
      nHooks: Object.keys(lock.hooks).length,
      wroteAgentsMd,
      claudeLink,
      claudeMode,
      sourceId: cat.sourceId,
      moved,
      removed,
    }
    // In --all (quiet) the caller prints an aligned line per repo; standalone we
    // print our own block here.
    if (!quiet) {
      const verb = dryRun ? `${c.dim('(dry-run)')} would sync` : c.green('synced')
      console.log(
        `${dryRun ? c.dim(SYM.skip) : c.green(SYM.ok)} ${verb} ${describe(result)} ` +
          `${c.dim('→')} ${c.bold(result.repoName)}  ${c.dim(`(${sourceLabel(cat.sourceId, sources)})`)}`,
      )
      for (const line of moved) console.log(`  ${c.cyan('moved')} ${line}`)
      const rverb = dryRun ? 'would remove' : 'removed'
      if (removed.skills.length) console.log(`  ${c.yellow(`${rverb} skills:`)} ${removed.skills.join(', ')}`)
      if (removed.agents.length) console.log(`  ${c.yellow(`${rverb} agents:`)} ${removed.agents.join(', ')}`)
      if (removed.hooks.length) console.log(`  ${c.yellow(`${rverb} hooks:`)} ${removed.hooks.join(', ')}`)
      if (dryRun) console.log(c.dim('dry run — nothing written. Re-run without --dry-run to apply.'))
    }
    return result
  } finally {
    if (!o.catalog) cat.cleanup()
    for (const x of own) x.cleanup()
  }
}

// "github:acme/skills" alone, or "github:acme/skills + 2 more" with extra sources.
/** @param {string} sourceId @param {ExtraSource[]} sources @returns {string} */
function sourceLabel(sourceId, sources) {
  return sources.length ? `${sourceId} + ${sources.length} more` : sourceId
}

// --- fleet mode -------------------------------------------------------------
// Re-sync every immediate subfolder of `root` that has a skills-syncer.json,
// each from its OWN recorded source + selection. Repos are grouped by source so
// a shared catalog is fetched once, not once per repo.
// `claudeLink`, when given, overrides every repo's recorded value — that is how a
// whole fleet switches its CLAUDE.md shape in one run.
/** @param {{ root: string, dryRun: boolean, claudeLink?: ClaudeLink, hooks?: boolean }} o
 *  @returns {number} exit code */
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

  // Width the repo column to the longest name so the descriptions line up.
  const pad = repos.reduce((w, n) => Math.max(w, n.length), 0)
  const multiSource = groups.size > 1
  console.log(
    `\n${c.bold('skills-syncer')} ${c.dim('·')} ${dryRun ? 'previewing' : 'syncing'} ` +
      `${c.bold(repos.length)} repo(s)` +
      (skipped ? c.dim(`  (${skipped} skipped — no skills-syncer.json)`) : ''),
  )

  /** @type {string[]} */ const ok = []
  /** @type {string[]} */ const failed = []
  // Extra sources are resolved on first use and kept for the whole run, so two
  // repos that take the same upstream clone it once. A source that failed to
  // resolve keeps its error, and every repo that needs it fails the same way.
  /** @type {Map<string, Catalog | SyncError>} */
  const extras = new Map()
  /** @param {string} from @returns {Catalog} */
  const resolveExtra = (from) => {
    if (!extras.has(from)) {
      try {
        extras.set(from, resolveCatalog(from))
      } catch (err) {
        if (!(err instanceof SyncError)) throw err
        extras.set(from, err)
      }
    }
    const got = extras.get(from)
    if (got instanceof SyncError) throw got
    return /** @type {Catalog} */ (got)
  }
  try {
    for (const grp of groups.values()) {
      // Source line once per group, not once per repo (the old noise).
      console.log(`${c.dim('  from')} ${c.cyan(grp.from || '<bundled>')}`)
      const catalog = tryResolve(grp.from)
      if (!catalog) {
        for (const name of grp.repos) {
          console.log(`    ${c.red(SYM.fail)} ${name.padEnd(pad)}  ${c.red('source could not be resolved')}`)
          failed.push(name)
        }
        continue
      }
      try {
        for (const name of grp.repos) {
          /** @type {Config} */
          const cfg = readJson(join(root, name, 'skills-syncer.json')) || {}
          try {
            const r = sync({
              cwd: join(root, name), from: grp.from,
              skills: cfg.skills || [], agents: cfg.agents || [], sources: cfg.sources,
              claudeLink: o.claudeLink ?? cfg.claudeLink,
              hooks: o.hooks ?? cfg.hooks,
              dryRun, catalog, resolve: resolveExtra, quiet: true,
            })
            console.log(`    ${c.green(SYM.ok)} ${c.bold(name.padEnd(pad))}  ${describe(r)}`)
            for (const line of r.moved) console.log(`      ${c.cyan('moved')} ${line}`)
            ok.push(name)
          } catch (err) {
            if (!(err instanceof SyncError)) throw err
            console.log(`    ${c.red(SYM.fail)} ${c.bold(name.padEnd(pad))}  ${c.red(err.message)}`)
            failed.push(name)
          }
        }
      } finally {
        catalog.cleanup()
      }
    }
  } finally {
    for (const x of extras.values()) if (!(x instanceof SyncError)) x.cleanup()
  }

  // Summary: keep the machine-greppable "synced N repo(s), skipped M" wording.
  const head = failed.length ? c.yellow('done with errors') : c.green('done')
  console.log(
    `\n${head} ${c.dim('·')} ${dryRun ? 'previewed' : 'synced'} ${c.bold(ok.length)} repo(s)` +
      `, skipped ${skipped} (no skills-syncer.json)` +
      (failed.length ? c.red(`, failed: ${failed.join(', ')}`) : ''),
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

// --- .claude/settings.json hooks merge ---------------------------------------
// A hook script is dead weight until settings.json points at it. The catalog
// owns that wiring in its own settings.json; we merge ONLY its `hooks` block.
//
// We record every group we install in the lock. A later sync takes those exact
// groups back out before it adds the new ones. So the repo's own hooks survive,
// and a hook dropped from the catalog is dropped from the repo too.
//
// `srcSettings` is null when the repo opted out; then we only remove ours.
/** @param {string} cwd @param {string | null} srcSettings @param {string[]} prevOwned
 *  @param {boolean} dryRun @returns {string[]} the groups we own after this run */
function syncSettingsHooks(cwd, srcSettings, prevOwned, dryRun) {
  const src = srcSettings && existsSync(srcSettings) ? readJson(srcSettings) : null
  const srcHooks = (src && src.hooks) || {}
  const dest = join(cwd, '.claude', 'settings.json')
  const cur = readJson(dest)
  if (!cur && !Object.keys(srcHooks).length) return []

  const owned = new Set(prevOwned)
  /** @param {string} event @param {any} group @returns {string} */
  const idOf = (event, group) => `${event} ${JSON.stringify(group)}`

  // Keep what the repo wrote. Drop what we installed last time.
  /** @type {Record<string, any[]>} */
  const next = {}
  for (const [event, groups] of Object.entries((cur && cur.hooks) || {})) {
    const kept = (Array.isArray(groups) ? groups : []).filter((g) => !owned.has(idOf(event, g)))
    if (kept.length) next[event] = kept
  }

  /** @type {string[]} */
  const nowOwned = []
  for (const [event, groups] of Object.entries(srcHooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!next[event]) next[event] = []
      const same = JSON.stringify(g)
      if (!next[event].some((x) => JSON.stringify(x) === same)) next[event].push(g)
      nowOwned.push(idOf(event, g))
    }
  }

  const merged = { ...(cur || {}) }
  if (Object.keys(next).length) merged.hooks = next
  else delete merged.hooks

  if (!dryRun) {
    if (Object.keys(merged).length) {
      mkdirSync(dirname(dest), { recursive: true })
      writeJsonStable(dest, merged)
    } else if (existsSync(dest)) {
      // We created it and we are the last thing in it — leave no empty file.
      rmSync(dest, { force: true })
    }
  }
  return nowOwned
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

// --- CLAUDE.md → AGENTS.md ---------------------------------------------------
// AGENTS.md is the cross-tool standard; CLAUDE.md is Claude Code's own name for
// the same instructions. Three ways to tie them together, picked per repo:
//
//   'symlink' (default) CLAUDE.md is a symlink to AGENTS.md
//   'import'            CLAUDE.md is a REAL file holding `@AGENTS.md`, the
//                       Claude Code import — a link in content, not in the
//                       filesystem. For hosts, checkouts, or tools that do not
//                       follow symlinks (Windows without developer mode, an
//                       archive export, a copy step that dereferences).
//   'off'               no CLAUDE.md at all
//
// Either link keeps ONE copy of the text: the target is a sibling in the SAME
// repo, so it rides with git into every worktree and the Docker sandbox.
const CLAUDE_IMPORT = '@AGENTS.md\n'

// Config/CLI value -> the mode to apply. Anything unset means the default.
/** @param {ClaudeLink | undefined} v @returns {'symlink' | 'import' | 'off'} */
function claudeModeOf(v) {
  if (v === false) return 'off'
  if (v === 'import') return 'import'
  return 'symlink'
}

// What sits at CLAUDE.md today. `symlink`/`import` are the two shapes this tool
// writes; `stale-link` is a symlink pointing somewhere else (still ours to
// repoint — a symlink named CLAUDE.md is this tool's business); `foreign` is a
// real file or dir the repo authored, which is never touched.
/** @param {string} dest @returns {'symlink' | 'import' | 'stale-link' | 'foreign' | 'absent'} */
function claudeMdKind(dest) {
  let state
  try {
    state = lstatSync(dest)
  } catch {
    return 'absent'
  }
  if (state.isSymbolicLink()) return readlinkSync(dest) === 'AGENTS.md' ? 'symlink' : 'stale-link'
  if (!state.isFile()) return 'foreign'
  return readFileSync(dest, 'utf8').trim() === CLAUDE_IMPORT.trim() ? 'import' : 'foreign'
}

// Put CLAUDE.md into the wanted shape. Never clobbers a repo-authored file.
// Idempotent: a CLAUDE.md already in that shape is left alone.
/** @param {string} cwd @param {boolean} dryRun @param {'symlink' | 'import'} mode
 *  @returns {'created' | 'fixed' | 'ok' | 'skipped'} */
function syncClaudeMd(cwd, dryRun, mode) {
  const dest = join(cwd, 'CLAUDE.md')
  const kind = claudeMdKind(dest)
  if (kind === mode) return 'ok'
  if (kind === 'foreign') {
    // A real file/dir the repo authored — do not overwrite it.
    const how = mode === 'import' ? 'write the @AGENTS.md import' : 'link CLAUDE.md → AGENTS.md'
    console.warn(`[skills-syncer] skip CLAUDE.md symlink: ${dest} is a real file the repo authored. Remove it to let the sync ${how}.`)
    return 'skipped'
  }
  // Absent, a stale link, or the other shape (switching modes) — write ours.
  if (!dryRun) {
    if (kind !== 'absent') unlinkSync(dest)
    if (mode === 'symlink') symlinkSync('AGENTS.md', dest)
    else writeFileSync(dest, CLAUDE_IMPORT)
  }
  return kind === 'absent' ? 'created' : 'fixed'
}

// The opt-out (`--no-claude-link` / `"claudeLink": false`): never create the
// link, and take back one this tool made — but only that one. A repo-authored
// CLAUDE.md, or a symlink pointing somewhere else, stays.
/** @param {string} cwd @param {boolean} dryRun
 *  @returns {'removed' | 'off'} */
function dropClaudeMdLink(cwd, dryRun) {
  const dest = join(cwd, 'CLAUDE.md')
  const kind = claudeMdKind(dest)
  if (kind !== 'symlink' && kind !== 'import') return 'off'
  if (!dryRun) unlinkSync(dest)
  return 'removed'
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
  --no-claude-link  don't link CLAUDE.md → AGENTS.md; remove one this tool
                    made. Recorded in skills-syncer.json, so later re-syncs
                    (including --all) keep the repo opted out
  --claude-link     opt back in: CLAUDE.md is a symlink to AGENTS.md (default)
  --claude-import   CLAUDE.md is a real file holding "@AGENTS.md", the Claude
                    Code import — same one-copy result, no symlink
  --no-hooks        don't vendor the catalog's hooks; remove ones this tool
                    installed. Recorded in skills-syncer.json, so later
                    re-syncs (including --all) keep the repo opted out
  --hooks           opt back in (default)
  --dry-run, -n     show what would change; write nothing
  --help, -h        show this help
  --version, -v     print the version

Writes .claude/skills/, .claude/agents/, .claude/hooks/, the hooks block of
.claude/settings.json, AGENTS.md, skills-syncer.json and skills-syncer-lock.json
into the current repo. Commit the result.

Hooks follow the catalog, not the skill selection: a hook is repo-wide wiring,
so every repo gets all of them, or none via --no-hooks.

More than one source: add a "sources" list to skills-syncer.json, then re-sync.
  "sources": [{ "from": "github:owner/repo#tag", "skills": ["name"] }]
An extra source gives skills and agents only. The main source alone writes
AGENTS.md, CLAUDE.md and the hooks. One name in two sources stops the sync.`

const VALUE_FLAGS = new Set(['--from', '--root']) // take exactly one value
const LIST_FLAGS = new Set(['--skill', '--agent']) // take a list until the next flag
const KNOWN_FLAGS = new Set([
  ...VALUE_FLAGS,
  ...LIST_FLAGS,
  '--all',
  '--claude-import',
  '--claude-link',
  '--no-claude-link',
  '--hooks',
  '--no-hooks',
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
    // Unlike the selection flags, these DO apply to --all: they override each
    // repo's recorded value, so a fleet can be flipped in one run.
    const claudeFlags = ['--claude-link', '--claude-import', '--no-claude-link'].filter((f) => argv.includes(f))
    if (claudeFlags.length > 1) fail(`${claudeFlags.join(' and ')} contradict each other. Pass one.`)
    /** @type {ClaudeLink | undefined} */
    const claudeLinkArg =
      claudeFlags[0] === '--no-claude-link'
        ? false
        : claudeFlags[0] === '--claude-import'
          ? 'import'
          : claudeFlags[0] === '--claude-link'
            ? 'symlink'
            : undefined

    const hookFlags = ['--hooks', '--no-hooks'].filter((f) => argv.includes(f))
    if (hookFlags.length > 1) fail(`${hookFlags.join(' and ')} contradict each other. Pass one.`)
    /** @type {boolean | undefined} */
    const hooksArg = hookFlags[0] === '--no-hooks' ? false : hookFlags[0] === '--hooks' ? true : undefined

    if (argv.includes('--all')) {
      for (const f of ['--from', '--skill', '--agent'])
        if (argv.includes(f))
          console.warn(`[skills-syncer] --all ignores ${f}: each repo re-syncs from its own skills-syncer.json`)
      const rootArg = parseValueArg(argv, '--root')
      const root = rootArg ? resolve(rootArg) : process.cwd()
      if (!existsSync(root)) fail(`--root path does not exist: ${root}`)
      process.exitCode = runAll({ root, dryRun, claudeLink: claudeLinkArg, hooks: hooksArg })
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
    const claudeLink = claudeLinkArg ?? config.claudeLink
    const hooks = hooksArg ?? config.hooks
    sync({ cwd, from: from || undefined, skills, agents, sources: config.sources, claudeLink, hooks, dryRun })
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

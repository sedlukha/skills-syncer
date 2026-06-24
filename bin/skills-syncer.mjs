#!/usr/bin/env node
// skills-syncer — vendor Claude Code skills + agents from ANY catalog into your repo.
//
//   npx skills-syncer --from github:acme/our-skills --skill '*'
//   npx skills-syncer --from ./local-catalog --skill fsd-rules react-rules
//   npx skills-syncer --from github:acme/our-skills --skill run-maintain --agent worker
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
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, relative, basename } from 'node:path'

const cwd = process.cwd()

// Markers that fence the shared block inside a repo's AGENTS.md.
const SHARED_BEGIN = '<!-- shared — managed by skills-syncer. Edit it in the source catalog, not here. -->'
const SHARED_END = '<!-- end shared. Put repo-specific notes below this line. -->'

// --- tiny CLI parser --------------------------------------------------------
// `--from X` takes one value; `--skill a b c` / `--agent a b c` take a list
// that runs until the next `--flag`. Each list accepts '*'.
function parseValueArg(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}
function parseListArg(argv, flag) {
  const i = argv.indexOf(flag)
  if (i === -1) return null
  const out = []
  for (let j = i + 1; j < argv.length; j++) {
    if (argv[j].startsWith('--')) break
    out.push(argv[j])
  }
  return out
}

// --- source resolution ------------------------------------------------------
// Returns { root, cleanup }. A `github:owner/repo[#ref]` source is shallow-cloned
// to a temp dir; a local path is used in place.
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
      fail(`could not clone ${url}${ref ? ` (ref ${ref})` : ''}\n  ${String(err.stderr || err.message).trim()}`)
    }
    return { root: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }
  const root = resolve(from)
  if (!existsSync(root)) fail(`source path does not exist: ${root}`)
  return { root, cleanup: () => {} }
}

// Auto-detect where skills/agents live in the source.
function pick(root, ...candidates) {
  for (const c of candidates) {
    const p = join(root, ...c)
    if (existsSync(p)) return p
  }
  return join(root, ...candidates[candidates.length - 1]) // default to last
}

// --- fs + hashing helpers ---------------------------------------------------
function listDirs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
}
function listAgents(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md'))
}
function walkRel(dir) {
  const out = []
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
function dirHash(dir) {
  const h = createHash('sha256')
  for (const rel of walkRel(dir)) {
    h.update(`${rel}\0`)
    h.update(readFileSync(join(dir, rel)))
  }
  return h.digest('hex')
}
function fileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
function readJson(p) {
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
// Throw rather than process.exit, so the outer finally always runs cleanup
// (a github: source has a temp clone to remove).
class SyncError extends Error {}
function fail(msg) {
  throw new SyncError(msg)
}

// --- resolve source + selection ---------------------------------------------
let cleanup = () => {}
try {
  const argv = process.argv.slice(2)
  const config = readJson(join(cwd, 'skills-syncer.json')) || {}

  const from = parseValueArg(argv, '--from') || config.from
  if (!from) {
    fail('no source. pass --from <github:owner/repo | ./path>, or add it to skills-syncer.json.')
  }

  const src = resolveSource(from)
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
  const keepKnown = (names, available, kind) => {
    for (const n of names.filter((n) => !available.includes(n)))
      console.warn(`[skills-syncer] skip ${kind} "${n}": not in source (deleted or misspelled)`)
    return names.filter((n) => available.includes(n))
  }
  skillSel = keepKnown(skillSel, availableSkills, 'skill')
  const explicitAgents = new Set(keepKnown(agentSel, availableAgents, 'agent'))

  // Agents required by selected skills, via the manifest.
  const requiredBy = new Map()
  for (const skill of skillSel) {
    for (const role of manifest[skill] || []) {
      if (!availableAgents.includes(role)) {
        console.warn(`[skills-syncer] ${skill} requires agent "${role}" but it is not in source — skip`)
        continue
      }
      if (!requiredBy.has(role)) requiredBy.set(role, [])
      requiredBy.get(role).push(skill)
    }
  }
  const agentsToInstall = new Set([...explicitAgents, ...requiredBy.keys()])

  // --- install --------------------------------------------------------------
  const skillsDest = join(cwd, '.claude', 'skills')
  const agentsDest = join(cwd, '.claude', 'agents')
  const prevLock = readJson(join(cwd, 'skills-syncer-lock.json'))
  const lock = { version: 1, source: from, skills: {}, agents: {} }

  for (const name of [...skillSel].sort()) {
    const src = join(srcSkillsDir, name)
    const dest = join(skillsDest, name)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, { recursive: true })
    lock.skills[name] = { hash: dirHash(src) }
  }

  if (agentsToInstall.size) mkdirSync(agentsDest, { recursive: true })
  for (const role of [...agentsToInstall].sort()) {
    const src = join(srcAgentsDir, `${role}.md`)
    const dest = join(agentsDest, `${role}.md`)
    rmSync(dest, { force: true })
    cpSync(src, dest)
    lock.agents[role] = {
      hash: fileHash(src),
      explicit: explicitAgents.has(role),
      requiredBy: (requiredBy.get(role) || []).sort(),
    }
  }

  // --- cleanup: drop what is no longer selected -----------------------------
  const removed = { skills: [], agents: [] }
  for (const name of prevLock?.skills ? Object.keys(prevLock.skills) : []) {
    if (lock.skills[name]) continue
    const dest = join(skillsDest, name)
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true })
      removed.skills.push(name)
    }
  }
  // Only agents OUR lock installed are eligible for removal — never a repo-authored one.
  for (const role of prevLock?.agents ? Object.keys(prevLock.agents) : []) {
    if (lock.agents[role]) continue
    const dest = join(agentsDest, `${role}.md`)
    if (existsSync(dest)) {
      rmSync(dest, { force: true })
      removed.agents.push(role)
    }
  }

  // --- shared AGENTS.md block -----------------------------------------------
  const wroteAgentsMd = syncAgentsMd(srcAgentsMd)

  // --- persist config + lock ------------------------------------------------
  writeFileSync(
    join(cwd, 'skills-syncer.json'),
    `${JSON.stringify({ from, skills: skillLiteral, agents: agentLiteral }, null, 2)}\n`,
  )
  writeFileSync(join(cwd, 'skills-syncer-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)

  // --- report ---------------------------------------------------------------
  const repo = basename(cwd)
  const nSkills = Object.keys(lock.skills).length
  const nAgents = Object.keys(lock.agents).length
  console.log(
    `[skills-syncer] synced ${nSkills} skill(s)` +
      (nAgents ? ` + ${nAgents} agent(s)` : '') +
      (wroteAgentsMd ? ' + AGENTS.md' : '') +
      ` into ${repo} (from ${from})`,
  )
  if (removed.skills.length) console.log(`[skills-syncer] removed skills: ${removed.skills.join(', ')}`)
  if (removed.agents.length) console.log(`[skills-syncer] removed agents: ${removed.agents.join(', ')}`)
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
function syncAgentsMd(srcAgentsMd) {
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
      if (rest.startsWith(shared)) rest = rest.slice(shared.length)
      rest = rest.replace(/^\s+/, '')
      body = rest ? `${block}\n\n${rest}` : block
    }
  }
  if (!body.endsWith('\n')) body += '\n'
  writeFileSync(dest, body)
  return true
}

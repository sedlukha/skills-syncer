// Smoke + behaviour tests for skills-syncer. Uses only Node built-ins
// (node:test, node:assert) so the package keeps its zero-dependency promise.
//
//   node --test
//
// Each test runs the real CLI as a child process against a throwaway catalog
// fixture, into a throwaway "repo" dir, and inspects what it wrote.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  utimesSync,
  statSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, '..', 'bin', 'skills-syncer.mjs')

// A shared, read-only catalog fixture built once.
/** @type {string} */
let CATALOG

before(() => {
  CATALOG = mkdtempSync(join(tmpdir(), 'sst-catalog-'))
  /** @param {string} rel @param {string} body */
  const w = (rel, body) => {
    const p = join(CATALOG, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  w('skills/hello-rules/SKILL.md', 'HELLO v1\n')
  w('skills/review-flow/SKILL.md', 'REVIEW v1\n')
  w('agents/worker.md', 'WORKER v1\n')
  w('agents/reviewer.md', 'REVIEWER v1\n')
  w('agents/solo.md', 'SOLO v1\n')
  w('skill-agents.json', JSON.stringify({ 'review-flow': ['worker', 'reviewer'] }))
  w('AGENTS.md', '# Shared\n\nUse plain English.\n')
})

// --- helpers ---------------------------------------------------------------
function newRepo() {
  return mkdtempSync(join(tmpdir(), 'sst-repo-'))
}
/** @param {string} repo @param {string[]} [args] @param {Record<string, any>} [opts] */
function run(repo, args = [], opts = {}) {
  const { _bin = BIN, ...spawnOpts } = opts
  const res = spawnSync(process.execPath, [_bin, ...args], {
    cwd: repo,
    encoding: 'utf8',
    ...spawnOpts,
  })
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' }
}
/** @param {string} repo @param {...string} rel @returns {string} */
const read = (repo, ...rel) => readFileSync(join(repo, ...rel), 'utf8')
/** @param {string} repo @param {...string} rel @returns {boolean} */
const has = (repo, ...rel) => existsSync(join(repo, ...rel))
/** @param {string} repo */
const lock = (repo) => JSON.parse(read(repo, 'skills-syncer-lock.json'))
/** @param {string} repo */
const config = (repo) => JSON.parse(read(repo, 'skills-syncer.json'))
/** @param {string} s @param {string} sub @returns {number} */
const occurrences = (s, sub) => s.split(sub).length - 1

// --- tests -----------------------------------------------------------------

test('clean install pulls a skill and its manifest-required agents', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'review-flow'])
  assert.equal(r.status, 0, r.stderr)

  assert.ok(has(repo, '.claude', 'skills', 'review-flow', 'SKILL.md'))
  assert.ok(has(repo, '.claude', 'agents', 'worker.md'), 'worker auto-pulled')
  assert.ok(has(repo, '.claude', 'agents', 'reviewer.md'), 'reviewer auto-pulled')

  const l = lock(repo)
  assert.deepEqual(Object.keys(l.skills), ['review-flow'])
  assert.deepEqual(Object.keys(l.agents).sort(), ['reviewer', 'worker'])
  assert.equal(l.agents.worker.explicit, false)
  assert.deepEqual(l.agents.worker.requiredBy, ['review-flow'])
  assert.match(l.skills['review-flow'].hash, /^[0-9a-f]{64}$/)

  // intent file keeps the literal selection, no hashes
  assert.deepEqual(config(repo), { from: CATALOG, skills: ['review-flow'], agents: [] })
})

test('an agent can be selected directly even if no skill needs it', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--agent', 'solo'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(has(repo, '.claude', 'agents', 'solo.md'))
  assert.equal(lock(repo).agents.solo.explicit, true)
})

test("'*' selection is stored literally for dynamic re-syncs", () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', '*'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(Object.keys(lock(repo).skills).sort(), ['hello-rules', 'review-flow'])
  assert.deepEqual(config(repo).skills, ['*'], 'literal star, not expanded')
})

test('narrowing the selection removes the dropped items, keeps the rest', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules', 'review-flow'])
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)

  assert.ok(has(repo, '.claude', 'skills', 'hello-rules'))
  assert.ok(!has(repo, '.claude', 'skills', 'review-flow'), 'dropped skill removed')
  // its required agents are no longer needed, so they go too
  assert.ok(!has(repo, '.claude', 'agents', 'worker.md'))
  assert.ok(!has(repo, '.claude', 'agents', 'reviewer.md'))
  assert.match(r.stdout, /removed skills: review-flow/)
})

test('a repo-authored skill or agent is never clobbered on install', () => {
  const repo = newRepo()
  // pre-existing files the repo owns, sharing names with the catalog
  mkdirSync(join(repo, '.claude', 'skills', 'hello-rules'), { recursive: true })
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'skills', 'hello-rules', 'SKILL.md'), 'REPO OWN\n')
  writeFileSync(join(repo, '.claude', 'agents', 'worker.md'), 'REPO OWN\n')

  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', 'review-flow', '--agent', 'worker'])
  assert.equal(r.status, 0, r.stderr)

  // untouched
  assert.equal(read(repo, '.claude', 'skills', 'hello-rules', 'SKILL.md'), 'REPO OWN\n')
  assert.equal(read(repo, '.claude', 'agents', 'worker.md'), 'REPO OWN\n')
  // and not adopted into our lock
  assert.ok(!lock(repo).skills['hello-rules'])
  assert.ok(!lock(repo).agents.worker)
  // warned about both
  assert.match(r.stderr, /skip skill "hello-rules".*repo-authored/s)
  assert.match(r.stderr, /skip agent "worker".*repo-authored/s)
  // the non-colliding sibling still installs
  assert.ok(has(repo, '.claude', 'skills', 'review-flow'))
  assert.ok(has(repo, '.claude', 'agents', 'reviewer.md'))
})

test('a locally edited copy is overwritten with a warning', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  writeFileSync(join(repo, '.claude', 'skills', 'hello-rules', 'SKILL.md'), 'LOCAL EDIT\n')

  const r = run(repo, []) // bare re-sync from skills-syncer.json
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /"hello-rules" was edited locally/)
  assert.equal(read(repo, '.claude', 'skills', 'hello-rules', 'SKILL.md'), 'HELLO v1\n')
})

test('AGENTS.md merge is idempotent and preserves repo notes below the block', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  // append a repo-specific note under the fenced block
  const withNote = `${read(repo, 'AGENTS.md').trimEnd()}\n\n## Repo note\n\nKeep me.\n`
  writeFileSync(join(repo, 'AGENTS.md'), withNote)

  run(repo, []) // re-sync
  const md = read(repo, 'AGENTS.md')
  assert.equal(occurrences(md, 'managed by skills-syncer'), 1, 'exactly one shared block')
  assert.match(md, /Keep me\./, 'repo note preserved')
})

test('bad source path fails cleanly with exit 1, not a crash', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', join(CATALOG, 'does-not-exist'), '--skill', 'x'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /\[skills-syncer\] source path does not exist/)
  assert.doesNotMatch(r.stderr, /at Object|node:internal/, 'no raw stack trace')
})

test('refuses to sync a local source into itself', () => {
  // run with cwd == the catalog itself
  const r = run(CATALOG, ['--from', '.', '--skill', '*'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /refusing to sync the source into itself/)
})

test('--help prints usage and exits 0 without a source', () => {
  const r = run(newRepo(), ['--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Usage:/)
  assert.match(r.stdout, /--dry-run/)
})

test('--version prints a semver and exits 0', () => {
  const r = run(newRepo(), ['--version'])
  assert.equal(r.status, 0)
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/)
})

test('--dry-run reports the plan but writes nothing', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'review-flow', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\(dry-run\) would sync/)
  assert.match(r.stdout, /nothing written/)
  // not a single artefact on disk
  assert.ok(!has(repo, '.claude'), 'no .claude written')
  assert.ok(!has(repo, 'skills-syncer.json'), 'no intent file written')
  assert.ok(!has(repo, 'skills-syncer-lock.json'), 'no lock written')
  assert.ok(!has(repo, 'AGENTS.md'), 'no AGENTS.md written')
})

test('--dry-run previews removals without deleting', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules', 'review-flow'])
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '-n'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /would remove skills: review-flow/)
  // still on disk — the dry run did not touch it
  assert.ok(has(repo, '.claude', 'skills', 'review-flow'), 'dropped skill untouched')
  // and the lock still records it
  assert.ok(lock(repo).skills['review-flow'])
})

// Build a "package" that bundles skills-syncer as its own bin and ships a
// catalog beside it — the `npx github:owner/catalog` shape.
function newBundledCatalog() {
  const pkg = mkdtempSync(join(tmpdir(), 'sst-bundle-'))
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  copyFileSync(BIN, join(pkg, 'bin', 'skills-syncer.mjs'))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'cat-pkg', version: '9.9.9' }))
  mkdirSync(join(pkg, '.claude', 'skills', 'foo'), { recursive: true })
  writeFileSync(join(pkg, '.claude', 'skills', 'foo', 'SKILL.md'), 'FOO\n')
  mkdirSync(join(pkg, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(pkg, '.claude', 'agents', 'bar.md'), 'BAR\n')
  writeFileSync(join(pkg, 'skill-agents.json'), JSON.stringify({ foo: ['bar'] }))
  writeFileSync(join(pkg, 'AGENTS.md'), '# Shared\n\nBe nice.\n')
  return join(pkg, 'bin', 'skills-syncer.mjs')
}

test('a bundled catalog is used as the source when no --from is given', () => {
  const bin = newBundledCatalog()
  const repo = newRepo()
  const r = run(repo, ['--skill', 'foo'], { _bin: bin })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(has(repo, '.claude', 'skills', 'foo', 'SKILL.md'))
  assert.ok(has(repo, '.claude', 'agents', 'bar.md'), 'manifest-required agent pulled')
  assert.ok(has(repo, 'AGENTS.md'), 'shared block written')
  // intent file records the selection but no ephemeral `from` path
  assert.deepEqual(config(repo), { skills: ['foo'], agents: [] })
  assert.equal(lock(repo).source, 'cat-pkg', 'lock records the package name')
  // a bare re-sync still resolves the bundled catalog from the selection
  const r2 = run(repo, [], { _bin: bin })
  assert.equal(r2.status, 0, r2.stderr)
  assert.ok(has(repo, '.claude', 'skills', 'foo', 'SKILL.md'))
})

test('a re-sync does not touch a skill folder whose content is unchanged', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  const dir = join(repo, '.claude', 'skills', 'hello-rules')
  // stamp a distinct old mtime; a real reinstall (rm + copy) would reset it
  const old = new Date('2020-01-01T00:00:00Z')
  utimesSync(dir, old, old)
  const r = run(repo, []) // bare re-sync — content is identical
  assert.equal(r.status, 0, r.stderr)
  assert.equal(statSync(dir).mtime.getTime(), old.getTime(), 'unchanged skill was not reinstalled')
})

test('--all keeps going when one repo’s source cannot be resolved', () => {
  const fleet = mkdtempSync(join(tmpdir(), 'sst-fleet-'))
  const good = join(fleet, 'good')
  const bad = join(fleet, 'bad')
  mkdirSync(good, { recursive: true })
  mkdirSync(bad, { recursive: true })
  writeFileSync(join(good, 'skills-syncer.json'), JSON.stringify({ from: CATALOG, skills: ['hello-rules'], agents: [] }))
  writeFileSync(join(bad, 'skills-syncer.json'), JSON.stringify({ from: join(fleet, 'no-such-catalog'), skills: ['x'], agents: [] }))

  const r = run(fleet, ['--all', '--root', fleet])
  assert.equal(r.status, 1, 'a failed repo makes the run exit non-zero')
  assert.match(r.stdout, /synced 1 repo\(s\).*failed: bad/)
  assert.ok(has(good, '.claude', 'skills', 'hello-rules'), 'the healthy repo still synced')
  assert.ok(!has(bad, '.claude'), 'the broken repo wrote nothing')
})

test('a re-sync leaves a reformatted state file untouched (no churn)', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'review-flow'])
  // simulate a formatter (biome/prettier) collapsing the JSON — same data,
  // different whitespace
  for (const f of ['skills-syncer.json', 'skills-syncer-lock.json']) {
    const p = join(repo, f)
    writeFileSync(p, JSON.stringify(JSON.parse(readFileSync(p, 'utf8'))))
  }
  const before = {
    intent: read(repo, 'skills-syncer.json'),
    lock: read(repo, 'skills-syncer-lock.json'),
  }
  const r = run(repo, []) // bare re-sync
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(repo, 'skills-syncer.json'), before.intent, 'intent file not rewritten')
  assert.equal(read(repo, 'skills-syncer-lock.json'), before.lock, 'lock file not rewritten')
})

test('--all re-syncs every subfolder that has a skills-syncer.json', () => {
  const fleet = mkdtempSync(join(tmpdir(), 'sst-fleet-'))
  // two participating repos (each records its own source + selection) ...
  for (const name of ['repo-a', 'repo-b']) {
    const repo = join(fleet, name)
    mkdirSync(repo, { recursive: true })
    writeFileSync(
      join(repo, 'skills-syncer.json'),
      JSON.stringify({ from: CATALOG, skills: ['hello-rules'], agents: [] }),
    )
  }
  // ... and one that is not a participant
  mkdirSync(join(fleet, 'not-a-repo'), { recursive: true })

  const r = run(fleet, ['--all', '--root', fleet])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /synced 2 repo\(s\), skipped 1/)
  assert.ok(has(join(fleet, 'repo-a'), '.claude', 'skills', 'hello-rules'))
  assert.ok(has(join(fleet, 'repo-b'), '.claude', 'skills', 'hello-rules'))
  // the non-participant is untouched
  assert.ok(!has(join(fleet, 'not-a-repo'), '.claude'))
})

test('--all --dry-run previews each repo without writing', () => {
  const fleet = mkdtempSync(join(tmpdir(), 'sst-fleet-'))
  const repo = join(fleet, 'repo-a')
  mkdirSync(repo, { recursive: true })
  writeFileSync(
    join(repo, 'skills-syncer.json'),
    JSON.stringify({ from: CATALOG, skills: ['hello-rules'], agents: [] }),
  )
  const r = run(fleet, ['--all', '--root', fleet, '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /previewed 1 repo/)
  assert.ok(!has(repo, '.claude'), 'dry-run wrote nothing')
})

test('an unknown flag fails loudly instead of being ignored', () => {
  const r = run(newRepo(), ['--from', CATALOG, '--skill', 'hello-rules', '--frobnicate'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unknown flag "--frobnicate"/)
})

test('a value flag with no value fails', () => {
  const r = run(newRepo(), ['--from'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /"--from" expects a value/)
})

test('a stray positional argument fails', () => {
  const r = run(newRepo(), ['oops', '--from', CATALOG, '--skill', 'hello-rules'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unexpected argument "oops"/)
})

test('--all warns that it ignores --skill, then still runs', () => {
  const fleet = mkdtempSync(join(tmpdir(), 'sst-fleet-'))
  const repo = join(fleet, 'r')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'skills-syncer.json'), JSON.stringify({ from: CATALOG, skills: ['hello-rules'], agents: [] }))
  const r = run(fleet, ['--all', '--root', fleet, '--skill', 'x'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /--all ignores --skill/)
  assert.ok(has(repo, '.claude', 'skills', 'hello-rules'))
})

/** @param {string} repo @returns {boolean} */
const isLink = (repo) => lstatSync(join(repo, 'CLAUDE.md')).isSymbolicLink()

test('CLAUDE.md is created as a symlink to AGENTS.md', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(isLink(repo), 'CLAUDE.md is a symlink')
  assert.equal(readlinkSync(join(repo, 'CLAUDE.md')), 'AGENTS.md', 'points at the sibling AGENTS.md')
  // Following the link yields the shared AGENTS.md content.
  assert.equal(read(repo, 'CLAUDE.md'), read(repo, 'AGENTS.md'))
})

test('--dry-run does not create the CLAUDE.md symlink', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, 'CLAUDE.md'), 'nothing written on a dry run')
})

test('a stale CLAUDE.md symlink is repointed at AGENTS.md', () => {
  const repo = newRepo()
  symlinkSync('README.md', join(repo, 'CLAUDE.md'))
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(isLink(repo))
  assert.equal(readlinkSync(join(repo, 'CLAUDE.md')), 'AGENTS.md')
})

test('a repo-authored real CLAUDE.md is left untouched, with a warning', () => {
  const repo = newRepo()
  writeFileSync(join(repo, 'CLAUDE.md'), 'MY OWN FILE\n')
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!isLink(repo), 'still a real file')
  assert.equal(read(repo, 'CLAUDE.md'), 'MY OWN FILE\n', 'content preserved')
  assert.match(r.stderr, /skip CLAUDE\.md symlink/)
})

test('--no-claude-link skips the symlink and records the opt-out', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--no-claude-link'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, 'CLAUDE.md'), 'no CLAUDE.md written')
  assert.equal(config(repo).claudeLink, false, 'opt-out recorded in skills-syncer.json')
  // The opt-out survives a plain re-sync that passes no flags.
  const again = run(repo, [])
  assert.equal(again.status, 0, again.stderr)
  assert.ok(!has(repo, 'CLAUDE.md'), 'still no CLAUDE.md')
  assert.equal(config(repo).claudeLink, false)
})

test('--no-claude-link removes a link this tool made', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  assert.ok(isLink(repo), 'linked by the first sync')
  const r = run(repo, ['--no-claude-link'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, 'CLAUDE.md'), 'link removed')
  assert.ok(has(repo, 'AGENTS.md'), 'AGENTS.md untouched')
})

test('--no-claude-link leaves a repo-authored CLAUDE.md alone', () => {
  const repo = newRepo()
  writeFileSync(join(repo, 'CLAUDE.md'), 'MY OWN FILE\n')
  symlinkSync('README.md', join(repo, 'OTHER.md'))
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--no-claude-link'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(repo, 'CLAUDE.md'), 'MY OWN FILE\n', 'real file preserved')
  assert.doesNotMatch(r.stderr, /skip CLAUDE\.md symlink/, 'no warning when the link is off')
})

test('--no-claude-link --dry-run removes nothing', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  const r = run(repo, ['--no-claude-link', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(isLink(repo), 'link still there')
  assert.equal(config(repo).claudeLink, undefined, 'opt-out not recorded on a dry run')
})

test('--claude-link opts a repo back in', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--no-claude-link'])
  const r = run(repo, ['--claude-link'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(isLink(repo), 'link restored')
  assert.equal(config(repo).claudeLink, undefined, 'opt-out dropped from skills-syncer.json')
})

test('--claude-link and --no-claude-link together fail', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--claude-link', '--no-claude-link'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /contradict/)
})

// --- CLAUDE.md as an @AGENTS.md import -------------------------------------

test('--claude-import writes a real CLAUDE.md holding @AGENTS.md', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--claude-import'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!isLink(repo), 'a real file, not a symlink')
  assert.equal(read(repo, 'CLAUDE.md'), '@AGENTS.md\n')
  assert.equal(config(repo).claudeLink, 'import', 'choice recorded')

  // The choice survives a bare re-sync, and the file is left alone.
  const again = run(repo, [])
  assert.equal(again.status, 0, again.stderr)
  assert.equal(read(repo, 'CLAUDE.md'), '@AGENTS.md\n')
  assert.equal(config(repo).claudeLink, 'import')
})

test('--claude-import replaces an existing symlink, and back again', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  assert.ok(isLink(repo), 'first sync linked it')

  run(repo, ['--claude-import'])
  assert.ok(!isLink(repo), 'symlink replaced by a real file')
  assert.equal(read(repo, 'CLAUDE.md'), '@AGENTS.md\n')

  run(repo, ['--claude-link'])
  assert.ok(isLink(repo), 'import file replaced by a symlink')
  assert.equal(readlinkSync(join(repo, 'CLAUDE.md')), 'AGENTS.md')
  assert.equal(config(repo).claudeLink, undefined, 'default is not recorded')
})

test('--no-claude-link removes an import file this tool wrote', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--claude-import'])
  const r = run(repo, ['--no-claude-link'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, 'CLAUDE.md'), 'import file removed')
  assert.equal(config(repo).claudeLink, false)
})

test('--claude-import leaves a repo-authored CLAUDE.md alone, with a warning', () => {
  const repo = newRepo()
  writeFileSync(join(repo, 'CLAUDE.md'), 'MY OWN FILE\n')
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--claude-import'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(repo, 'CLAUDE.md'), 'MY OWN FILE\n', 'content preserved')
  assert.match(r.stderr, /skip CLAUDE\.md/)
})

test('--claude-import --dry-run writes nothing', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--claude-import', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, 'CLAUDE.md'))
})

test('two contradicting CLAUDE.md flags fail', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules', '--claude-import', '--no-claude-link'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /contradict/)
})

test('--all --claude-import switches every repo at once', () => {
  const root = mkdtempSync(join(tmpdir(), 'sst-root-import-'))
  for (const name of ['a', 'b']) {
    const repo = join(root, name)
    mkdirSync(repo)
    run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
    assert.ok(isLink(repo), `${name} linked by the first sync`)
  }
  const r = run(root, ['--all', '--claude-import'])
  assert.equal(r.status, 0, r.stderr)
  for (const name of ['a', 'b']) {
    assert.ok(!isLink(join(root, name)), `${name} no longer a symlink`)
    assert.equal(read(join(root, name), 'CLAUDE.md'), '@AGENTS.md\n')
    assert.equal(config(join(root, name)).claudeLink, 'import')
  }
})

// --- JSON formatting -------------------------------------------------------
// The written files must already look like prettier/biome output. A repo runs
// its own formatter over them, and a re-sync must not fight it.

test('a short array stays on one line, objects still break', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'review-flow'])
  assert.equal(r.status, 0, r.stderr)

  const cfg = read(repo, 'skills-syncer.json')
  assert.match(cfg, /^ {2}"skills": \["review-flow"\],$/m, 'skills on one line')
  assert.match(cfg, /^ {2}"agents": \[\],?$/m, 'empty array stays []')

  const lk = read(repo, 'skills-syncer-lock.json')
  assert.match(lk, /^ {6}"requiredBy": \["review-flow"\]$/m, 'requiredBy on one line')
  assert.match(lk, /^ {2}"skills": \{$/m, 'objects still break, one key per line')
  assert.match(lk, /^ {4}"review-flow": \{$/m)
})

test('an array too long for the print width breaks one item per line', () => {
  // Long names, so the flat array cannot fit in 80 columns.
  const catalog = mkdtempSync(join(tmpdir(), 'sst-wide-'))
  const names = ['alpha-very-long-rules', 'bravo-very-long-rules', 'charlie-very-long-rules']
  for (const n of names) {
    mkdirSync(join(catalog, 'skills', n), { recursive: true })
    writeFileSync(join(catalog, 'skills', n, 'SKILL.md'), `${n}\n`)
  }
  const repo = newRepo()
  const r = run(repo, ['--from', catalog, '--skill', ...names])
  assert.equal(r.status, 0, r.stderr)

  const cfg = read(repo, 'skills-syncer.json')
  assert.match(cfg, /^ {2}"skills": \[$/m, 'array breaks')
  for (const n of names) assert.match(cfg, new RegExp(`^ {4}"${n}",?$`, 'm'), `${n} on its own line`)
  for (const line of cfg.split('\n')) assert.ok(line.length <= 80, `line fits 80 cols: ${line}`)
})

test('--all --no-claude-link opts every repo out at once', () => {
  const root = mkdtempSync(join(tmpdir(), 'sst-root-'))
  for (const name of ['a', 'b']) {
    const repo = join(root, name)
    mkdirSync(repo)
    run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
    assert.ok(isLink(repo), `${name} linked by the first sync`)
  }
  const r = run(root, ['--all'].concat('--no-claude-link'))
  assert.equal(r.status, 0, r.stderr)
  for (const name of ['a', 'b']) {
    assert.ok(!has(join(root, name), 'CLAUDE.md'), `${name} link removed`)
    assert.equal(config(join(root, name)).claudeLink, false, `${name} opt-out recorded`)
  }
})

// --- hooks -----------------------------------------------------------------
// Hooks ride with the catalog, not the skill selection, so they get their own
// fixture: a hook script plus the settings.json block that wires it up.

/** @param {{ settings?: any, hook?: string, second?: boolean }} [o] @returns {string} */
function hookCatalog(o = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sst-hookcat-'))
  /** @param {string} rel @param {string} body */
  const w = (rel, body) => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  w('skills/hello-rules/SKILL.md', 'HELLO v1\n')
  w('hooks/check.mjs', o.hook ?? 'CHECK v1\n')
  if (o.second) w('hooks/nested/extra.sh', 'EXTRA v1\n')
  w(
    'settings.json',
    JSON.stringify(
      o.settings ?? {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node check.mjs' }] }] },
      },
    ),
  )
  return root
}
/** @param {string} repo @returns {any} */
const settings = (repo) => JSON.parse(read(repo, '.claude', 'settings.json'))

test('hooks are vendored and wired into .claude/settings.json', () => {
  const repo = newRepo()
  const cat = hookCatalog()
  const r = run(repo, ['--from', cat, '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)

  assert.equal(read(repo, '.claude', 'hooks', 'check.mjs'), 'CHECK v1\n')
  assert.deepEqual(settings(repo).hooks.Stop, [
    { hooks: [{ type: 'command', command: 'node check.mjs' }] },
  ])
  assert.ok(lock(repo).hooks['check.mjs'].hash, 'hook hash recorded')
  assert.equal(lock(repo).settingsHooks.length, 1, 'settings group recorded')
  assert.match(r.stdout, /1 hook/)
})

test('a nested hook file is vendored too', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', hookCatalog({ second: true }), '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(repo, '.claude', 'hooks', 'nested', 'extra.sh'), 'EXTRA v1\n')
  assert.equal(Object.keys(lock(repo).hooks).length, 2)
})

test("the repo's own settings.json keys and hooks survive the merge", () => {
  const repo = newRepo()
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(
    join(repo, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] },
    }),
  )
  const r = run(repo, ['--from', hookCatalog(), '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)

  const s = settings(repo)
  assert.equal(s.model, 'opus', 'unrelated key kept')
  assert.equal(s.hooks.Stop.length, 2, 'repo hook + catalog hook')
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'mine.sh', 'repo hook kept first')
})

test('--no-hooks skips the hooks and records the opt-out', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', hookCatalog(), '--skill', 'hello-rules', '--no-hooks'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, '.claude', 'hooks'), 'no hooks dir')
  assert.ok(!has(repo, '.claude', 'settings.json'), 'no settings written')
  assert.equal(config(repo).hooks, false, 'opt-out recorded')
})

test('--no-hooks takes back hooks a previous sync installed', () => {
  const repo = newRepo()
  const cat = hookCatalog()
  run(repo, ['--from', cat, '--skill', 'hello-rules'])
  assert.ok(has(repo, '.claude', 'hooks', 'check.mjs'))

  const r = run(repo, ['--no-hooks'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, '.claude', 'hooks', 'check.mjs'), 'hook file removed')
  assert.ok(!has(repo, '.claude', 'settings.json'), 'empty settings file removed')
  assert.equal(lock(repo).settingsHooks.length, 0)
})

test('--no-hooks leaves the repo its own settings hooks', () => {
  const repo = newRepo()
  const cat = hookCatalog()
  run(repo, ['--from', cat, '--skill', 'hello-rules'])
  const s = settings(repo)
  s.hooks.Stop.push({ hooks: [{ type: 'command', command: 'mine.sh' }] })
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(s))

  run(repo, ['--no-hooks'])
  assert.deepEqual(settings(repo).hooks.Stop, [
    { hooks: [{ type: 'command', command: 'mine.sh' }] },
  ])
})

test('a repo-authored hook file is never clobbered', () => {
  const repo = newRepo()
  mkdirSync(join(repo, '.claude', 'hooks'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'hooks', 'check.mjs'), 'MINE\n')

  const r = run(repo, ['--from', hookCatalog(), '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(repo, '.claude', 'hooks', 'check.mjs'), 'MINE\n')
  assert.match(r.stderr, /repo-authored/)
})

test('a hook dropped from the catalog is dropped from the repo', () => {
  const repo = newRepo()
  run(repo, ['--from', hookCatalog({ second: true }), '--skill', 'hello-rules'])
  assert.ok(has(repo, '.claude', 'hooks', 'nested', 'extra.sh'))

  const r = run(repo, ['--from', hookCatalog(), '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, '.claude', 'hooks', 'nested', 'extra.sh'), 'stale hook removed')
  assert.ok(has(repo, '.claude', 'hooks', 'check.mjs'), 'current hook kept')
})

test('a changed hook is updated, and its old settings group replaced', () => {
  const repo = newRepo()
  run(repo, ['--from', hookCatalog(), '--skill', 'hello-rules'])
  const next = hookCatalog({
    hook: 'CHECK v2\n',
    settings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node check.mjs --v2' }] }] } },
  })
  const r = run(repo, ['--from', next, '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(repo, '.claude', 'hooks', 'check.mjs'), 'CHECK v2\n')
  assert.deepEqual(settings(repo).hooks.Stop, [
    { hooks: [{ type: 'command', command: 'node check.mjs --v2' }] },
  ])
})

test('--dry-run writes no hook and no settings', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', hookCatalog(), '--skill', 'hello-rules', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, '.claude', 'hooks'), 'no hooks dir')
  assert.ok(!has(repo, '.claude', 'settings.json'), 'no settings')
})

test('a re-sync with no change rewrites nothing', () => {
  const repo = newRepo()
  const cat = hookCatalog()
  run(repo, ['--from', cat, '--skill', 'hello-rules'])
  const before = statSync(join(repo, '.claude', 'settings.json')).mtimeMs
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(repo, '.claude', 'settings.json'), old, old)

  run(repo, [])
  assert.equal(
    statSync(join(repo, '.claude', 'settings.json')).mtimeMs,
    old.getTime(),
    'settings left untouched on a no-op re-sync',
  )
  assert.ok(before)
})

test('--hooks and --no-hooks together fail', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', hookCatalog(), '--skill', 'hello-rules', '--hooks', '--no-hooks'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /contradict/)
})

test('--hooks opts a repo back in', () => {
  const repo = newRepo()
  const cat = hookCatalog()
  run(repo, ['--from', cat, '--skill', 'hello-rules', '--no-hooks'])
  const r = run(repo, ['--hooks'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(has(repo, '.claude', 'hooks', 'check.mjs'), 'hook back')
  assert.equal(config(repo).hooks, undefined, 'opt-out cleared')
})

test('a catalog with no hooks touches no settings', () => {
  const repo = newRepo()
  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, '.claude', 'settings.json'), 'no settings file invented')
  assert.deepEqual(lock(repo).hooks, {})
})

// --- more than one source --------------------------------------------------
// The main source owns the shared files. An extra source, listed under
// "sources" in skills-syncer.json, gives skills and agents only.

/** @returns {string} an upstream catalog with its own AGENTS.md and hooks */
function extraCatalog() {
  const root = mkdtempSync(join(tmpdir(), 'sst-extra-'))
  /** @param {string} rel @param {string} body */
  const w = (rel, body) => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  w('skills/emails/SKILL.md', 'EMAILS v1\n')
  w('skills/hello-rules/SKILL.md', 'UPSTREAM HELLO\n')
  w('agents/writer.md', 'WRITER v1\n')
  w('skill-agents.json', JSON.stringify({ emails: ['writer'] }))
  w('AGENTS.md', '# Upstream\n\nDo it our way.\n')
  w('hooks/upstream.mjs', 'UPSTREAM HOOK\n')
  w('settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'up' }] }] } }))
  return root
}
/** @param {string} repo @param {any} intent */
const writeIntent = (repo, intent) => writeFileSync(join(repo, 'skills-syncer.json'), JSON.stringify(intent))

test('an extra source adds its skills and the agents they need', () => {
  const repo = newRepo()
  const extra = extraCatalog()
  const sources = [{ from: extra, skills: ['emails'] }]
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources })
  const r = run(repo, [])
  assert.equal(r.status, 0, r.stderr)

  assert.equal(read(repo, '.claude', 'skills', 'hello-rules', 'SKILL.md'), 'HELLO v1\n')
  assert.equal(read(repo, '.claude', 'skills', 'emails', 'SKILL.md'), 'EMAILS v1\n')
  assert.ok(has(repo, '.claude', 'agents', 'writer.md'), 'the extra manifest pulls its agent')

  const l = lock(repo)
  assert.equal(l.source, CATALOG, 'the lock still names the main source')
  assert.equal(l.skills['hello-rules'].from, undefined, 'a main item records no source')
  assert.equal(l.skills.emails.from, extra)
  assert.equal(l.agents.writer.from, extra)
  assert.deepEqual(config(repo).sources, sources, 'the sources list is kept as written')
  assert.match(r.stdout, /\+ 1 more/)
})

test('an extra source never writes AGENTS.md or hooks', () => {
  const repo = newRepo()
  const extra = extraCatalog()
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from: extra, skills: ['emails'] }] })
  const r = run(repo, [])
  assert.equal(r.status, 0, r.stderr)

  const agentsMd = read(repo, 'AGENTS.md')
  assert.match(agentsMd, /# Shared/)
  assert.doesNotMatch(agentsMd, /Upstream/)
  assert.ok(!has(repo, '.claude', 'hooks'), 'no upstream hook')
  assert.ok(!has(repo, '.claude', 'settings.json'), 'no upstream settings')
  assert.deepEqual(lock(repo).hooks, {})
})

test('a name in two sources stops the sync and names both sources', () => {
  const repo = newRepo()
  const extra = extraCatalog()
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from: extra, skills: ['hello-rules'] }] })
  const r = run(repo, [])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /skill "hello-rules" comes from two sources/)
  assert.ok(r.stderr.includes(CATALOG) && r.stderr.includes(extra), 'both sources named')
  assert.ok(!has(repo, '.claude'), 'nothing written')
})

test('dropping an extra source removes what it installed', () => {
  const repo = newRepo()
  const extra = extraCatalog()
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from: extra, skills: ['emails'] }] })
  run(repo, [])
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [] })
  const r = run(repo, [])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, '.claude', 'skills', 'emails'))
  assert.ok(!has(repo, '.claude', 'agents', 'writer.md'))
  assert.ok(has(repo, '.claude', 'skills', 'hello-rules'))
  assert.equal(config(repo).sources, undefined)
})

test('--from on the command line keeps the recorded sources', () => {
  const repo = newRepo()
  const extra = extraCatalog()
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from: extra, skills: ['emails'] }] })
  const r = run(repo, ['--from', CATALOG, '--skill', 'review-flow'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(has(repo, '.claude', 'skills', 'emails'), 'the extra skill stays')
  assert.equal(config(repo).sources.length, 1)
})

test('a "sources" entry with no "from" fails', () => {
  const repo = newRepo()
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ skills: ['emails'] }] })
  const r = run(repo, [])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /"sources" entry 1 in skills-syncer.json needs a "from"/)
})

test('--all syncs extra sources, and a broken one fails only its repo', () => {
  const fleet = mkdtempSync(join(tmpdir(), 'sst-fleet-'))
  const extra = extraCatalog()
  for (const [name, from] of [['a', extra], ['b', extra], ['bad', join(fleet, 'no-such-extra')]]) {
    mkdirSync(join(fleet, name))
    writeIntent(join(fleet, name), { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from, skills: ['emails'] }] })
  }
  const r = run(fleet, ['--all', '--root', fleet])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /synced 2 repo\(s\).*failed: bad/)
  assert.ok(has(join(fleet, 'a'), '.claude', 'skills', 'emails'))
  assert.ok(has(join(fleet, 'b'), '.claude', 'skills', 'emails'))
  assert.ok(!has(join(fleet, 'bad'), '.claude'))
})

// A github: source is cloned over the network. git's insteadOf turns
// https://github.com/ into a local folder, so the real clone path runs offline.
function githubUpstream() {
  const hub = mkdtempSync(join(tmpdir(), 'sst-hub-'))
  const up = join(hub, 'acme', 'extra.git')
  mkdirSync(join(up, 'skills', 'emails'), { recursive: true })
  /** @param {...string} args @returns {string} */
  const git = (...args) =>
    spawnSync('git', ['-C', up, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).stdout.trim()
  /** @param {string} rel @param {string} body @param {string} tag @returns {string} the new commit */
  const commit = (rel, body, tag) => {
    mkdirSync(dirname(join(up, rel)), { recursive: true })
    writeFileSync(join(up, rel), body)
    git('add', '-A')
    git('commit', '-qm', tag)
    git('tag', tag)
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q')
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${hub}/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  }
  return { commit, env }
}
/** @returns {string[]} the temp clones skills-syncer has left in tmpdir */
const clones = () => readdirSync(tmpdir()).filter((n) => n.startsWith('skills-syncer-'))

test('the lock records the commit of a github: source and reports a move', () => {
  const gh = githubUpstream()
  const first = gh.commit('skills/emails/SKILL.md', 'EMAILS v1\n', 'v1')
  const second = gh.commit('skills/emails/SKILL.md', 'EMAILS v2\n', 'v2')
  const repo = newRepo()
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from: 'github:acme/extra#v1', skills: ['emails'] }] })
  let r = run(repo, [], { env: gh.env })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(repo, '.claude', 'skills', 'emails', 'SKILL.md'), 'EMAILS v1\n')
  assert.deepEqual(lock(repo).commits, { 'github:acme/extra': first }, 'keyed without the #ref')
  assert.doesNotMatch(r.stdout, /moved/)

  writeIntent(repo, { ...config(repo), sources: [{ from: 'github:acme/extra#v2', skills: ['emails'] }] })
  r = run(repo, [], { env: gh.env })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(repo, '.claude', 'skills', 'emails', 'SKILL.md'), 'EMAILS v2\n')
  assert.equal(lock(repo).commits['github:acme/extra'], second)
  assert.ok(r.stdout.includes(`moved github:acme/extra: ${first.slice(0, 7)} → ${second.slice(0, 7)}`), r.stdout)
})

test('a new commit that changes no selected item leaves the lock alone', () => {
  const gh = githubUpstream()
  const first = gh.commit('skills/emails/SKILL.md', 'EMAILS v1\n', 'v1')
  const repo = newRepo()
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from: 'github:acme/extra', skills: ['emails'] }] })
  run(repo, [], { env: gh.env })
  const before = read(repo, 'skills-syncer-lock.json')

  gh.commit('README.md', 'docs only\n', 'docs')
  const r = run(repo, [], { env: gh.env })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(repo, 'skills-syncer-lock.json'), before, 'lock not rewritten')
  assert.equal(lock(repo).commits['github:acme/extra'], first)
  assert.doesNotMatch(r.stdout, /moved/)
})

test('a temp clone is removed when the sync fails after it', () => {
  const gh = githubUpstream()
  gh.commit('skills/hello-rules/SKILL.md', 'UPSTREAM HELLO\n', 'v1')
  const repo = newRepo()
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from: 'github:acme/extra', skills: ['hello-rules'] }] })
  const left = clones()
  const r = run(repo, [], { env: gh.env })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /comes from two sources/)
  assert.deepEqual(clones(), left, 'no clone left behind')
})

test('"sources" of the wrong shape fails cleanly, also under --all', () => {
  const fleet = mkdtempSync(join(tmpdir(), 'sst-fleet-'))
  /** @type {Record<string, any>} */
  const cases = {
    object: { from: CATALOG, skills: ['emails'] },
    string: [{ from: CATALOG, skills: 'emails' }],
  }
  for (const [name, sources] of Object.entries(cases)) {
    mkdirSync(join(fleet, name))
    writeIntent(join(fleet, name), { from: CATALOG, skills: ['hello-rules'], agents: [], sources })
    const r = run(join(fleet, name), [])
    assert.equal(r.status, 1)
    assert.doesNotMatch(r.stderr, /TypeError/)
  }
  assert.match(run(join(fleet, 'object'), []).stderr, /"sources" in skills-syncer.json must be a list/)
  assert.match(run(join(fleet, 'string'), []).stderr, /"sources" entry 1 in skills-syncer.json: "skills" must be a list/)

  mkdirSync(join(fleet, 'good'))
  writeIntent(join(fleet, 'good'), { from: CATALOG, skills: ['hello-rules'], agents: [] })
  const r = run(fleet, ['--all', '--root', fleet])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /synced 1 repo\(s\)/, 'the healthy repo still synced')
})

test('one source listed twice fails before any clone', () => {
  const repo = newRepo()
  const extra = extraCatalog()
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from: extra, skills: ['emails'] }, { from: extra, agents: ['writer'] }] })
  const r = run(repo, [])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /is listed twice/)
})

test('an agent clash says which skills pulled the agent in', () => {
  const repo = newRepo()
  const extra = extraCatalog()
  // both catalogs ship a "worker" agent; each one comes in through a skill
  mkdirSync(join(extra, 'skills', 'drafts'))
  writeFileSync(join(extra, 'skills', 'drafts', 'SKILL.md'), 'DRAFTS\n')
  writeFileSync(join(extra, 'agents', 'worker.md'), 'UPSTREAM WORKER\n')
  writeFileSync(join(extra, 'skill-agents.json'), JSON.stringify({ drafts: ['worker'] }))
  writeIntent(repo, { from: CATALOG, skills: ['review-flow'], agents: [], sources: [{ from: extra, skills: ['drafts'] }] })
  const r = run(repo, [])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /agent "worker" comes from two sources/)
  assert.match(r.stderr, /required by "review-flow"/)
  assert.match(r.stderr, /required by "drafts"/)
})

test('--dry-run with an extra source writes nothing', () => {
  const repo = newRepo()
  const extra = extraCatalog()
  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from: extra, skills: ['emails'] }] })
  const before = read(repo, 'skills-syncer.json')
  const r = run(repo, ['--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!has(repo, '.claude'))
  assert.ok(!has(repo, 'skills-syncer-lock.json'))
  assert.equal(read(repo, 'skills-syncer.json'), before)
})

test('a skill moved from the main source to an extra one is kept and relabelled', () => {
  const repo = newRepo()
  const extra = extraCatalog()
  run(repo, ['--from', extra, '--skill', 'emails'])
  assert.equal(lock(repo).skills.emails.from, undefined)

  writeIntent(repo, { from: CATALOG, skills: ['hello-rules'], agents: [], sources: [{ from: extra, skills: ['emails'] }] })
  const r = run(repo, [])
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stderr, /repo-authored/)
  // its hook goes, because only the main source gives hooks; the skill stays
  assert.doesNotMatch(r.stdout, /removed skills/)
  assert.equal(read(repo, '.claude', 'skills', 'emails', 'SKILL.md'), 'EMAILS v1\n')
  assert.equal(lock(repo).skills.emails.from, extra)
})

test('a lock from local sources only has no commits field', () => {
  const repo = newRepo()
  run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  assert.equal(lock(repo).commits, undefined)
})

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
  utimesSync,
  statSync,
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

test('adopting over a different tool’s fenced block does not duplicate it', () => {
  const repo = newRepo()
  // a repo previously managed by another tool: its own markers around the shared
  // text, with repo notes below
  const shared = readFileSync(join(CATALOG, 'AGENTS.md'), 'utf8').trim()
  const old =
    `<!-- OLD TOOL begin -->\n\n${shared}\n\n<!-- OLD TOOL end -->\n\n## Repo note\n\nKeep me.\n`
  // install something so AGENTS.md is synced
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, 'AGENTS.md'), old)

  const r = run(repo, ['--from', CATALOG, '--skill', 'hello-rules'])
  assert.equal(r.status, 0, r.stderr)
  const md = read(repo, 'AGENTS.md')
  assert.equal(occurrences(md, 'managed by skills-syncer'), 1, 'one managed block')
  assert.equal(occurrences(md, 'OLD TOOL'), 0, 'old fence removed')
  assert.equal(occurrences(md, 'Use plain English'), 1, 'shared text not duplicated')
  assert.match(md, /Keep me\./, 'repo note preserved')
})

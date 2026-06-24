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
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, '..', 'bin', 'skills-syncer.mjs')

// A shared, read-only catalog fixture built once.
let CATALOG

before(() => {
  CATALOG = mkdtempSync(join(tmpdir(), 'sst-catalog-'))
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
function run(repo, args = [], opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: repo,
    encoding: 'utf8',
    ...opts,
  })
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' }
}
const read = (repo, ...rel) => readFileSync(join(repo, ...rel), 'utf8')
const has = (repo, ...rel) => existsSync(join(repo, ...rel))
const lock = (repo) => JSON.parse(read(repo, 'skills-syncer-lock.json'))
const config = (repo) => JSON.parse(read(repo, 'skills-syncer.json'))
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

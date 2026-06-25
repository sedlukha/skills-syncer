# Project Instructions — skills-syncer

A tiny CLI that vendors Claude Code **skills** and **subagents** from a catalog
(a local path or a `github:` repo) into the repo it is run from. One executable
script, zero runtime dependencies.

## Layout

```
skills-syncer/
  bin/skills-syncer.mjs   # the whole tool — a single Node ESM script
  package.json            # name + bin; no deps
  README.md               # usage scenarios
  AGENTS.md               # this file
  LICENSE                 # MIT
```

There is no `src/`, no build step, and no `dist/`. The published artifact is the
script itself, run via `npx skills-syncer`.

## Architecture

The script is organized around one function, `sync(options)`, that vendors a
catalog into a single repo. The CLI `main()` parses argv and calls it; `--all`'s
`runAll()` groups sibling repos by their recorded source, resolves each source
**once**, and calls `sync()` per repo with the shared catalog — so a fleet pull
fetches a `github:` catalog one time, not once per repo. A pre-resolved catalog
is passed in via `options.catalog`; the caller then owns its cleanup.

Installs are **incremental and atomic**: per item, the source hash is compared to
what is on disk and an unchanged item is skipped (no copy); a changed one is
copied to a `*.skills-syncer-tmp` sibling and renamed into place, so a failed
copy never destroys an existing folder. `writeJsonStable` does the same for the
two JSON state files — it skips the write when the parsed data is unchanged, so a
re-sync stays a clean no-op even if an external formatter reflowed them.

## Hard rules

- **No runtime dependencies.** The tool uses only Node built-ins (`node:fs`,
  `node:crypto`, `node:child_process`, `node:os`, `node:path`). Do not add a
  dependency to make the script run — if a feature needs one, reconsider the
  feature. `devDependencies` (TypeScript for type-checking) are fine: they are
  excluded from the published package by the `files` allowlist.
- **No build step.** Keep it a runnable `.mjs` with a `#!/usr/bin/env node`
  shebang. It must work via `node bin/skills-syncer.mjs` and `npx skills-syncer`
  with nothing compiled.
- **Node ≥ 18.** Only use APIs available there. `git` on PATH is required *only*
  for `github:` sources; local-path sources must work with no external tools.
- **Idempotent and non-destructive.** A re-sync may only touch what the lockfile
  installed, and only re-copies an item whose content actually changed. Never
  remove or overwrite a repo-authored skill or agent. Installs go through a temp
  sibling + rename so a crash never leaves a half-written folder. Errors must
  throw `SyncError` (not `process.exit`) so the `finally` in `sync()`/`runAll()`
  always runs cleanup — a `github:` source leaves a temp clone that must go.

## Conventions

- ES modules, 2-space indent, single quotes, no semicolons — match the existing
  style in `bin/skills-syncer.mjs`.
- The source is type-checked with `// @ts-check` + JSDoc (no `.ts`, no build).
  Keep it green: `npm run typecheck`. Add JSDoc types for new functions and
  annotate object literals TypeScript would otherwise infer as `never[]`.
- User-facing lines are prefixed `[skills-syncer]`. Keep messages short and
  actionable; name the file or item involved.
- The two state files are distinct: `skills-syncer.json` is hand-editable intent
  (source + selection); `skills-syncer-lock.json` is generated (per-item hash).
  Never write hashes into the intent file.

## Verifying a change

Run the test suite — it uses only Node's built-in runner, so no install is
needed:

```bash
node --test        # or: npm test
```

Tests live in `test/` and drive the real CLI as a child process against a
throwaway catalog fixture. They cover: selection installed, manifest-required
agents pulled, cleanup on a narrowed selection, repo-authored files never
clobbered, locally-edited copies overwritten with a warning, `AGENTS.md` merged
with a single shared block, an unchanged item skipped on re-sync (no churn), and
`--all` fleet mode (incl. carrying on past a failed repo). Add a case here when
you change behaviour.

For a quick manual smoke test against a real catalog:

```bash
T=$(mktemp -d) && cd "$T"
node /path/to/skills-syncer/bin/skills-syncer.mjs --from <catalog> --skill '*'
find .claude -maxdepth 2 | sort
cat skills-syncer.json skills-syncer-lock.json
```

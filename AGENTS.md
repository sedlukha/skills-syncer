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

## Hard rules

- **No runtime dependencies.** The tool uses only Node built-ins (`node:fs`,
  `node:crypto`, `node:child_process`, `node:os`, `node:path`). Do not add a
  dependency to make the script run — if a feature needs one, reconsider the
  feature.
- **No build step.** Keep it a runnable `.mjs` with a `#!/usr/bin/env node`
  shebang. It must work via `node bin/skills-syncer.mjs` and `npx skills-syncer`
  with nothing compiled.
- **Node ≥ 18.** Only use APIs available there. `git` on PATH is required *only*
  for `github:` sources; local-path sources must work with no external tools.
- **Idempotent and non-destructive.** A re-sync may only touch what the lockfile
  installed. Never remove or overwrite a repo-authored skill or agent. Errors
  must throw `SyncError` (not `process.exit`) so the outer `finally` always runs
  cleanup — a `github:` source leaves a temp clone that must be removed.

## Conventions

- ES modules, 2-space indent, single quotes, no semicolons — match the existing
  style in `bin/skills-syncer.mjs`.
- User-facing lines are prefixed `[skills-syncer]`. Keep messages short and
  actionable; name the file or item involved.
- The two state files are distinct: `skills-syncer.json` is hand-editable intent
  (source + selection); `skills-syncer-lock.json` is generated (per-item hash).
  Never write hashes into the intent file.

## Verifying a change

There is no test runner yet. Verify by running the script against a real catalog
into a throwaway directory and inspecting the result:

```bash
T=$(mktemp -d) && cd "$T"
node /path/to/skills-syncer/bin/skills-syncer.mjs --from <catalog> --skill '*'
find .claude -maxdepth 2 | sort
cat skills-syncer.json skills-syncer-lock.json
```

Always check: selection installed, manifest-required agents pulled, cleanup on a
narrowed selection, `AGENTS.md` merged with a single shared block, and no
`skills-syncer-*` temp dirs left in `$TMPDIR` after an error path.

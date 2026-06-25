# skills-syncer

[![CI](https://github.com/sedlukha/skills-syncer/actions/workflows/ci.yml/badge.svg)](https://github.com/sedlukha/skills-syncer/actions/workflows/ci.yml)

Vendor [Claude Code](https://docs.claude.com/claude-code) **skills** and the
**subagents** they use from one catalog into many repos — real file copies,
recorded by a lockfile. One source of truth instead of a copy you hand-edit
everywhere.

Unlike a git submodule or a symlink, each repo gets a **real copy** committed
into `.claude/`, so teammates, CI, and sandboxes never need this tool at runtime
— only the person adding or updating a skill runs the sync.

- Zero runtime dependencies (Node built-ins only).
- No build step — run it straight from npm with `npx`.
- `git` is needed only for `github:` sources; local catalogs need nothing.

## Quick start

Run from the repo you want to set up. `npx` fetches the tool; the catalog comes
from `--from`:

```bash
npx skills-syncer --from github:acme/our-skills --skill fsd-rules react-rules
```

Then **commit** what it wrote: `.claude/skills/`, `.claude/agents/` (if any),
`AGENTS.md`, `skills-syncer.json`, and `skills-syncer-lock.json`.

## Usage scenarios

### 1. Set up a brand-new repo

Pick the skills you want; their required agents come along automatically.

```bash
npx skills-syncer --from github:acme/our-skills --skill fsd-rules react-rules
```

### 2. Install everything

```bash
npx skills-syncer --from github:acme/our-skills --skill '*' --agent '*'
```

A `'*'` selection is stored literally in `skills-syncer.json`, so a later bare
re-sync (scenario 4) picks up skills added to the catalog since.

### 3. Add an agent on its own

Agents are a first-class catalog — install one directly even if no selected skill
requires it.

```bash
npx skills-syncer --from github:acme/our-skills --skill run-maintain --agent worker
```

### 4. Re-sync later to pull catalog updates

With no flags, the source and selection are read from `skills-syncer.json`. Run
this after the catalog changes to refresh this repo's copies:

```bash
npx skills-syncer
```

Commit the diff. Because it is idempotent, re-running with no changes is a no-op.

### 5. Narrow or change the selection

Pass a new `--skill`/`--agent` set. Items dropped from the selection are removed
from `.claude/` (the run prints `removed skills: …`); repo-authored skills and
agents are never touched.

```bash
# was fsd-rules + react-rules; now just fsd-rules — react-rules is removed
npx skills-syncer --from github:acme/our-skills --skill fsd-rules
```

### 6. Develop against a local catalog

Point `--from` at a checkout or any folder. Useful while authoring skills before
pushing them.

```bash
npx skills-syncer --from ../our-skills --skill '*'
npx skills-syncer --from /abs/path/to/catalog --skill fsd-rules
```

### 7. Pin to a branch or tag

Append `#ref` to a `github:` source to clone a specific branch or tag.

```bash
npx skills-syncer --from github:acme/our-skills#v2 --skill '*'
```

### 8. Roll a catalog change out to many repos at once

The tool is pull-only: a change reaches a repo only when the sync runs there.
`--all` re-syncs **every immediate subfolder that has a `skills-syncer.json`** —
each from its own recorded source and selection — so one command updates a whole
folder of repos. Run it from the folder that holds them (or pass `--root`):

```bash
cd ~/code/myorg          # a folder of sibling repos
npx skills-syncer --all              # re-sync each repo from its own source
npx skills-syncer --all --dry-run    # preview every repo, write nothing
npx skills-syncer --all --root ~/code/myorg   # scan a specific folder
```

It walks one level deep (worktrees and nested repos are not reached) and reports
how many repos synced, were skipped (no `skills-syncer.json`), or failed. Repos
that share a source are grouped, so a `github:` catalog is **fetched once**, not
once per repo, and a repo whose source fails doesn't stop the rest.

Every sync is **incremental**: an item already matching the catalog is left
untouched, so a re-sync with nothing to do is a true no-op (no file churn).

### 9. Preview a sync without writing

`--dry-run` (or `-n`) computes the full plan — what would be installed,
overwritten, or removed — and writes nothing. Re-run without it to apply.

```bash
npx skills-syncer --from github:acme/our-skills --skill '*' --dry-run
```

## Flags

| Flag | Meaning |
| --- | --- |
| `--from <src>` | catalog source: `github:owner/repo[#ref]` or a local path |
| `--skill <names…>` | skills to install (`'*'` = all in the catalog) |
| `--agent <names…>` | agents to install directly (`'*'` = all); a selected skill's required agents come automatically |
| `--all` | re-sync every immediate subfolder that has a `skills-syncer.json` |
| `--root <dir>` | with `--all`, the folder to scan (default: current dir) |
| `--dry-run`, `-n` | show what would change; write nothing |
| `--help`, `-h` | show usage |
| `--version`, `-v` | print the version |

With no flags, the source and selection are read from `skills-syncer.json`.

## The source catalog

A source is just a directory — a `github:owner/repo[#ref]` (shallow-cloned) or a
local path — laid out like this:

```
<catalog>/
  skills/<name>/SKILL.md ...     # or .claude/skills/<name>/  (auto-detected)
  agents/<role>.md               # or .claude/agents/<role>.md
  skill-agents.json              # optional: { "<skill>": ["<agent>", ...] }
  AGENTS.md                      # optional: shared instructions block
```

- **Skills and agents are two catalogs.** An agent installs when it is named with
  `--agent`, or required by a selected skill via `skill-agents.json`. So selecting
  an orchestrator skill never leaves it without its agents.
- **`AGENTS.md`** is merged into the top of the target repo's `AGENTS.md` inside
  fenced markers; repo-specific notes below the block are preserved across
  re-syncs.

### Bundled catalog (ship the tool with your catalog)

A catalog repo can **bundle** skills-syncer as its own `bin`, so consumers run it
straight from the catalog with no `--from`:

```jsonc
// package.json in your catalog repo
{ "bin": { "your-catalog": "bin/skills-syncer.mjs" } }
```

```bash
npx github:acme/our-skills --skill '*'   # the catalog is its own source
```

When no `--from` is given and there is no `skills-syncer.json`, the tool falls
back to its own package root if that carries a catalog (`skills/`,
`.claude/skills/`, …). The lock records the catalog's package name as the source,
and `skills-syncer.json` keeps only the selection (a bare re-sync resolves the
bundled catalog again).

## What it writes into your repo

| File | Role |
| --- | --- |
| `.claude/skills/<name>/` | each selected skill folder (real copy) |
| `.claude/agents/<role>.md` | each selected/required agent (registered subagent) |
| `AGENTS.md` | shared block merged in, repo notes kept below |
| `skills-syncer.json` | your choice: source + selection (hand-editable, committed) |
| `skills-syncer-lock.json` | generated manifest: per-item content hash |

A re-sync replaces only what the lock installed and removes what you dropped from
the selection — it never touches a repo-authored skill or agent.

`skills-syncer.json` is hand-editable — change the `from`, `skills`, or `agents`
fields and run a bare `npx skills-syncer` instead of retyping flags:

```json
{
  "from": "github:acme/our-skills",
  "skills": ["fsd-rules", "react-rules"],
  "agents": ["worker"]
}
```

## Requirements

- Node ≥ 18
- `git` on PATH (only for `github:` sources; local paths need nothing)

## License

MIT

# Example catalog

A minimal, working **source catalog** for [skills-syncer](../../README.md). Point
`--from` at this folder to see a full sync end to end:

```bash
# from a throwaway target repo
npx skills-syncer --from /path/to/skills-syncer/examples/catalog --skill '*' --agent '*'
```

## What's here

```
catalog/
  skills/
    hello-rules/SKILL.md      # a standalone skill — needs no agents
    review-flow/SKILL.md      # an orchestrator skill — needs two agents
  agents/
    worker.md
    reviewer.md
  skill-agents.json           # review-flow -> [worker, reviewer]
  AGENTS.md                   # shared block merged into the target repo
```

This catalog uses the top-level `skills/` and `agents/` layout. The
`.claude/skills/` and `.claude/agents/` layout works too — skills-syncer
auto-detects whichever is present.

## Things it demonstrates

- **A standalone skill.** Selecting `hello-rules` installs just the skill.
- **Manifest-driven agents.** Selecting `review-flow` auto-pulls `worker` and
  `reviewer`, because `skill-agents.json` lists them. You never have to name them
  by hand.
- **A shared `AGENTS.md` block.** On sync it is merged into the top of the target
  repo's `AGENTS.md`, leaving any repo-specific notes below it untouched.

## Try the pieces

```bash
# just the standalone skill — no agents installed
npx skills-syncer --from ./examples/catalog --skill hello-rules

# the orchestrator — worker + reviewer come along automatically
npx skills-syncer --from ./examples/catalog --skill review-flow

# an agent on its own, regardless of skills
npx skills-syncer --from ./examples/catalog --agent reviewer
```

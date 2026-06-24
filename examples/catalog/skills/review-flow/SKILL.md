---
name: review-flow
description: "Example orchestrator skill. Plans a change, implements it, then reviews it."
user-invocable: true
allowed-tools: Read, Grep, Glob
---

# Review flow

An example orchestrator skill that delegates to subagents. It needs the `worker`
and `reviewer` agents — and `skill-agents.json` records that, so selecting this
skill auto-installs both. This is the pattern to copy when a skill drives other
agents.

## Flow

1. Read the request and the affected files.
2. Hand the implementation to the `worker` agent, one step at a time.
3. Hand the result to the `reviewer` agent for a read-only pass.
4. Apply review feedback and stop when the reviewer is satisfied.

## Why a manifest

The skill must never run without its agents. Listing them in `skill-agents.json`
means a consumer who picks `review-flow` always gets `worker` and `reviewer`
too — they never have to know the dependency exists.

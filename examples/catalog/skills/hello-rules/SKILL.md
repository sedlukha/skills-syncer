---
name: hello-rules
description: "Example standalone skill. Greeting and tone conventions for the project."
user-invocable: false
allowed-tools: Read, Edit, Write, Grep, Glob
---

# Hello rules

An example skill that needs no agents — selecting it installs only this folder.
Replace this body with your real guidance; the structure is what matters.

## Conventions

- Greet the reader in plain language.
- Keep rules short and imperative: "Do X", "Never Y".
- One concern per skill. If a rule belongs to another domain, put it in that
  skill and let a manifest pull both when needed.

## Example

> **Do** lead with the action. **Never** bury the rule under three sentences of
> preamble.

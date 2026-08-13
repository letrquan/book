# Domain Docs

This repository uses a single-context domain-documentation layout.

## Before exploring, read these

- **`CONTEXT.md`** at the repository root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If these paths don't exist, **proceed silently**. Don't flag their absence or suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-another-decision.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept—such as in an issue title, refactor proposal, hypothesis, or test name—use the term defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use, or there's a real gap to note for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (example decision) — but worth reopening because…_

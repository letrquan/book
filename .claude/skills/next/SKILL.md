---
name: next
description: Audit Book's project direction by reconciling committed state, worktrees, branches, PRs, issues, plans, and milestones, then ranking the smallest daily-drive improvement. Use only when invoked as `$next`, `$next research`, or `$next refresh`. Not for code review, implementation, or resuming an edit.
allowed-tools:
  - Read
  - Grep
  - Glob
  - AskUserQuestion
  - Write(docs/current-state.md)
  - Bash(node .claude/skills/next/scripts/inspect.mjs*)
  - WebSearch
  - WebFetch
disable-model-invocation: true
---

# Next

Every judgement answers one question: **does this make the owner daily-drive Book instead of
Claude Code?** Backlog order and plan-phase completion are evidence, not goals.

Run from the repository root. Never paste inspector JSON or raw tool output into the answer.

## Modes

- No argument: inspect current state, reconcile active work, and rank the next 3-5 candidates.
- `research`: run only the research workflow in
  [references/research-lenses.md](references/research-lenses.md).
- `refresh`: verify bounded implementation state and offer a scoped `docs/current-state.md` update.
- Any other argument: report `Usage: $next [research|refresh]` and stop.

## Safety and scope

- Do not edit code, delete branches, merge, rebase, commit, push, open PRs, or change milestones.
- The normal and research modes are read-only except that `--fetch` refreshes remote-tracking refs.
- `refresh` may write only `docs/current-state.md`, after an in-run `AskUserQuestion` confirmation.
- Treat committed `main` as shipped state. Report uncommitted work separately; do not fold it into
  snapshot or refresh claims.
- If `docs/current-state.md` already has uncommitted edits, report the overlap and do not refresh it.
- Treat every checked-out worktree as active. Never recommend cleanup for it.
- A branch can be `READY FOR PR`; only a non-draft PR with successful CI and a mergeable GitHub
  state can be `MERGE`.

## Deterministic inspection

Use the packaged inspector instead of handwritten shell pipelines:

```text
node .claude/skills/next/scripts/inspect.mjs all --fetch --pretty
```

It is cross-platform and reports:

- drift from the exact `main` commit that last changed `docs/current-state.md`;
- changed non-test source files and hotspots;
- every linked worktree and its status;
- local and `origin` branches, ahead/behind counts, patch equivalence, and dry-merge conflicts;
- open PRs, CI, mergeability, issues, plan status lines, and unchecked milestones.

If fetch fails, state the newest known origin-ref date and do not recommend remote cleanup. If `gh`
is unavailable, say PRs and issues were unavailable and rank from local evidence.

## Default workflow

1. Run the full inspector.
2. Read `docs/current-state.md`. If no non-test source files changed since its commit, use it as the
   state baseline. Otherwise verify at most three claimed surfaces selected from the inspector's
   top hotspots and mark everything else `unverified-this-run`.
3. Verify a surface by tracing its declaration through shared dispatch or importers to its host
   handlers and tests. Do not infer absence from an empty search or a fixed list of entrypoint files;
   use a second term and follow the architecture actually present.
4. Classify verified surfaces as `wired-and-tested`, `wired-but-thin`, or
   `documented-but-unwired`.
5. Reconcile worktrees, branches, PRs, and issues using the inspector's evidence states. Report
   decisions; do not perform them.
6. Read [references/ranking.md](references/ranking.md), score 3-5 candidates, and recommend one
   smallest useful slice.

Output four compact sections: current state, active/sediment work, ranked candidates, and one
recommendation. Then ask whether the owner wants to implement it. Do not start implementation.

## Refresh workflow

1. Run `node .claude/skills/next/scripts/inspect.mjs state --pretty`.
2. Verify at most three changed surfaces; if there is no drift, say no refresh is needed and stop.
3. Preserve the document's existing H1/H2 structure and prose-versus-bullet shape.
4. Rewrite only claims verified this run. Carry all others forward and list them as
   `surfaces not re-verified this run` in the introduction.
5. Do not advance test-count claims unless the relevant tests ran in this same session. Otherwise
   make the verification paragraph explicitly say tests were not re-run.
6. Show a concise draft or diff, then use `AskUserQuestion`:
   `Write this refresh to docs/current-state.md?`
   Write only after approval and stop afterward.

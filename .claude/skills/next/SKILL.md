---
name: next
description: Find the next thing worth doing on Book across every aspect of the product — the feature/completeness board, plus deep aspect reviews (UI/UX craft, harness quality, and any file added under references/aspects/). Reconciles committed state, worktrees, branches, PRs, issues, plans, and milestones, then ranks the smallest daily-drive improvement. Use only when invoked as `$next`, `$next <aspect>`, `$next research`, or `$next refresh`. Not for code review, implementation, or resuming an edit.
allowed-tools:
  - Read
  - Grep
  - Glob
  - AskUserQuestion
  - Write(docs/current-state.md)
  - Bash(node .claude/skills/next/scripts/inspect.mjs*)
  - Bash(node dist/*)
  - Bash(npm run build*)
  - WebSearch
  - WebFetch
disable-model-invocation: true
---

# Next

Every judgement answers one question: **does this make the owner daily-drive Book instead of
Claude Code?** Backlog order and plan-phase completion are evidence, not goals.

Run from the repository root. Never paste inspector JSON or raw tool output into the answer.

## Modes

- No argument: inspect current state, reconcile active work, run one deep aspect review, and rank
  the next 3-5 candidates across the board and that aspect.
- An aspect name: run only the deep review defined by the matching `references/aspects/<name>.md`.
  The valid names are exactly the basenames of the files in that directory — adding a file there
  adds a mode with no edit here. Current aspects: `ui`, `harness`.
- `research`: run only the research workflow in
  [references/research-lenses.md](references/research-lenses.md).
- `refresh`: verify bounded implementation state and offer a scoped `docs/current-state.md` update.
- Any other argument: list the valid arguments — `research`, `refresh`, and the basename of every
  file in `references/aspects/` — and stop.

## Safety and scope

- Do not edit code, delete branches, merge, rebase, commit, push, open PRs, or change milestones.
- Every mode is read-only **toward the repository**, with two exceptions: `--fetch` refreshes
  remote-tracking refs, and `refresh` may write `docs/current-state.md` as described below.
  Observing Book itself — running the built binary or a
  scripted PTY session to look at the real TUI — is reading, and the UI aspect prefers it. Never
  launch an interactive TUI in a shell that cannot drive it, and never let an observation run
  mutate the working tree.
- `refresh` may write only `docs/current-state.md`, after an in-run `AskUserQuestion` confirmation.
- Treat the inspector's baseline — `origin/main` when it exists, local `main` otherwise — as
  shipped state. Report uncommitted work separately; do not fold it into snapshot or refresh
  claims.
- If `docs/current-state.md` already has uncommitted edits, report the overlap and do not refresh it.
- Treat every checked-out worktree as active. Never recommend cleanup for it.
- A branch can be `READY FOR PR`; only a non-draft PR with successful CI and a mergeable GitHub
  state can be `MERGE`.

## Deterministic inspection

Use the packaged inspector instead of handwritten shell pipelines:

```text
node .claude/skills/next/scripts/inspect.mjs all --fetch --pretty
```

It is cross-platform, measures everything against a `baseline` of `origin/main` when that ref
exists (local `main` goes stale in linked worktrees; the report includes how far behind it is),
and reports:

- drift from the exact baseline commit that last changed `docs/current-state.md`;
- changed non-test source files and hotspots;
- every linked worktree and its status;
- local and `origin` branches, ahead/behind counts, patch equivalence, and dry-merge conflicts;
- open PRs, CI (skipped and neutral checks pass; pending checks are `CI RUNNING`), mergeability,
  issues, plan status lines, and unchecked milestones. A PR verdict of `MERGEABILITY UNKNOWN`
  means CI passed but GitHub has not recomputed mergeability yet — report it as "CI green,
  mergeability pending", neither blocked nor `MERGE`.

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
6. Pick exactly ONE aspect from `references/aspects/` for a deep pass and say why: prefer the
   aspect implicated by recent churn (the same surfaces fixed repeatedly in the inspector's
   hotspots or `CHANGELOG.md`), then the aspect that has gone longest without a deep pass. One
   real pass beats several thin scans — never run more than one aspect here, and never skip it.
   Run that aspect file's deep review.
7. Read [references/ranking.md](references/ranking.md), score 3-5 candidates drawn from the board
   and the aspect findings together, and recommend one smallest useful slice.

Output five compact sections: current state, active/sediment work, the aspect review (which
aspect, why it was chosen, findings or a clean pass), ranked candidates, and one recommendation.
Name the strongest candidate from each source (board and aspect) before the single
recommendation. Then ask whether the owner wants to implement it. Do not start implementation.

## Aspect workflow

For `$next <aspect>`:

1. Run `node .claude/skills/next/scripts/inspect.mjs state --fetch --pretty` for drift and
   hotspot context; skip the full board.
2. Run the aspect file's deep review exactly as written there.
3. Rank only its findings with [references/ranking.md](references/ranking.md), recommend one
   slice, and ask. Zero surviving findings is a valid result — report the clean pass and stop; do
   not fall back into the default workflow.

## Refresh workflow

1. Run `node .claude/skills/next/scripts/inspect.mjs state --fetch --pretty`.
2. Verify at most three changed surfaces; if there is no drift, say no refresh is needed and stop.
3. Preserve the document's existing H1/H2 structure and prose-versus-bullet shape.
4. Rewrite only claims verified this run. Carry all others forward and list them as
   `surfaces not re-verified this run` in the introduction.
5. Do not advance test-count claims unless the relevant tests ran in this same session. Otherwise
   make the verification paragraph explicitly say tests were not re-run.
6. Show a concise draft or diff, then use `AskUserQuestion`:
   `Write this refresh to docs/current-state.md?`
   Write only after approval and stop afterward.

# Plan: Tool Reliability for Heterogeneous Models

- **Date:** 2026-07-26
- **Status:** Complete; implemented 2026-07-26 and hardened through 2026-08-04
- **Scope:** Built-in tool argument contracts, edit-tool failure behavior, tool-failure observability, and model-conditional mutation guidance
- **Goal:** Reduce tool-call failures (especially file mutations) across non-frontier and non-Anthropic models without per-model profiles, adaptive behavior, or changes to canonical tool semantics.

The motivation and design sections below are retained as the decision record. The authoritative
implementation status is the tracking table at the end of this document; the README "File
mutations" section describes current user-facing behavior.

**Relationship to the adaptive harness plan:** none of this implements or advances
[adaptive-harness-implementation-plan.md](adaptive-harness-implementation-plan.md). Phases 1 and 3
here are fixed-runtime work (the harness plan itself classifies tool semantics as runtime
responsibility, not adaptation). Phase 2 instrumentation is independently useful now and happens to
be evidence the harness plan's Phase 0/2 would later require. Nothing here introduces learned or
evidence-driven behavior.

---

## Motivation and evidence

Local evidence (session logs on this machine, primary model `qwen3.7-max` via an
openai-compatible router):

- The model called Grep with a Claude Code–style `path` argument and received
  `invalid_arguments: arguments.path is not allowed` — then **retried the identical call three
  times**. Book's schemas deviate from the conventions most models are post-trained on
  (Claude Code / OpenHands style), and `additionalProperties: false` turns every trained-in habit
  into a hard failure.
- Across **all** persisted Book sessions: Read 78, Grep 41, Bash 30, Glob 26 — versus Edit 1,
  MultiEdit 1, Write 0, ApplyPatch 0. There is currently **no baseline at all** for edit
  reliability.
- Tool failures are only discoverable by grepping raw session JSONL.

External evidence (primary sources; see research digest in the 2026-07-26 session):

- Edit-format compliance is strongly model-dependent: Aider's leaderboard "correct edit format"
  ranges ~64–100% per model (Qwen3-32B ≈ 84%); OpenAI-style patch envelopes fail ~50% on
  Grok-4/GLM-4.7-class models ("The Harness Problem", Feb 2026, 16 models × 180 tasks).
- Aider measured **9× more edit errors** with strict patch application vs. flexible application;
  Gemini CLI and Roo ship fuzzy-recovery for exact-match failures.
- Claude Code's own tracker estimates 15–20% first-attempt edit failure in production, with retry
  loops burning ~20% of output tokens — whitespace, stale reads, and format drift dominate.
- Anthropic tool-writing guidance: error messages should be actionable prose that teaches the
  correct call; measure tool-error rate, not just task success.

## Design decisions (review these first)

| # | Decision |
| --- | --- |
| D1 | Tool **exposure stays uniform** across models. All mutation tools remain `MUTATION_CORE`. Only the prompt *recommendation* varies. |
| D2 | **Canonical argument names do not change** (no session/docs/schema breakage). Compatibility is added via argument aliases only. |
| D3 | The built-in edit-format preference is **family-level with exactly two branches** (GPT/Codex family → patch, everything else → replace). Finer granularity comes only from user settings. The built-in table must never grow into a per-model registry. |
| D4 | Fuzzy edit matching applies **only when the relaxed match is unique in the file** and only when `replaceAll` is false. Ambiguity or zero matches still fail. |
| D5 | No adaptive, learned, or evidence-driven behavior anywhere in this plan. |
| D6 | Argument aliasing applies to **built-in tools only** — never MCP tools (external schemas are authoritative). |
| D7 | Read-before-edit is enforced for `Edit`/`MultiEdit` always and for `Write` over an **existing** file. `ApplyPatch` is exempt: its context lines self-anchor, matching Codex semantics. File creation is exempt. |
| D8 | The repeated-failure circuit breaker is **advisory only** (escalated error text). It never blocks a call. |

---

## Phase 1 — Tool robustness (model-agnostic)

Highest value; every item independently shippable. No behavior depends on which model is active.

### 1.1 Argument-name aliases for file tools

`src/tools/registry-core.ts` already has `TOOL_ARGUMENT_ALIASES` (currently Bash/Task tools only)
applied in `prepare()` before validation. Extend it:

| Tool | New aliases (alias → canonical) |
| --- | --- |
| Read | `file_path` → `filePath`, `path` → `filePath` |
| Write | `file_path` → `filePath` |
| Edit | `file_path` → `filePath`, `old_string` → `oldString`, `new_string` → `newString`, `replace_all` → `replaceAll` |
| MultiEdit | `file_path` → `filePath`; per-item in `edits[]`: `old_string`/`new_string`/`replace_all` |
| Grep | `glob` → `include`, `-A`/`-B` → `A`/`B` |

Work:

- Extend `normalizeToolArguments()` to support nested aliasing for array items (MultiEdit's
  `edits[]`). Keep the existing conflict rule: canonical key wins when both are present; alias key
  is always removed.
- Existing direction quirks stay as-is (`Bash.run_in_background` is canonical snake_case; aliases
  map *to* whatever is canonical per tool).

Tests (`src/tools/registry.test.ts`): per-tool alias mapping, nested `edits[]` mapping, canonical
precedence when both spellings present, MCP-prefixed names untouched.

### 1.2 Grep `path` parameter (and `C` context)

The `path` failure was a *functional* gap, not just naming: the model legitimately needed to scope
a search to a subdirectory and had no way to express it.

- Add optional `path` (directory or file, workspace-relative or absolute-inside-workspace) to the
  Grep schema in `src/tools/file.ts`; resolve via `resolveWorkspacePath` and reject
  outside-workspace values with the existing message.
- Ripgrep backend: replace the trailing `'.'` with the resolved path. Portable backend: prefix the
  fast-glob `include` pattern with the relative path.
- Add optional `C` (context both directions), merged as `A = max(A, C)`, `B = max(B, C)` —
  matches ripgrep/Claude Code conventions.

Tests (`src/tools/file.test.ts`): scoped search hits only files under `path`, traversal rejection,
`C` merging, both backends (`BOOK_GREP_BACKEND=typescript` covers portable).

### 1.3 `invalid_arguments` errors that teach the correct call

In `src/tools/registry-core.ts` (~line 236), append the allowed keys to the message:

```
Invalid arguments for Grep: arguments.path is not allowed.
Allowed arguments: pattern, include, path, output_mode, A, B, C, multiline, head_limit.
```

Derived from `tool.inputSchema.properties` — generic, so it also helps MCP tools. Test asserts the
allowed-list suffix.

### 1.4 Actionable Edit/MultiEdit failure text + description hardening

- `text_not_found` in `src/tools/file.ts` gains a `remediation` (the field already exists on
  `toolFailure` and is rendered for other codes):
  `oldString must byte-for-byte match file content. Check exact whitespace and indentation, do not
  include the "N: " line-number prefixes from Read output, and re-Read the file if it may have
  changed.`
- Edit/MultiEdit descriptions gain one sentence: exact-match semantics and the line-number-prefix
  warning. Read's description notes that the `N: ` prefixes are display-only and never part of
  file content.

Tests: message/remediation assertions in `file.test.ts`.

### 1.5 Whitespace-tolerant fallback matching (unique-only)

New `src/tools/fuzzy-match.ts` (pure functions, no state):

Ladder, tried in order, stopping at the first rung that yields **exactly one** match:

1. Exact (current behavior, after existing CRLF normalization).
2. Trailing-whitespace-insensitive per line.
3. Uniform-indentation-shift: the whole `oldString` block matches when every line is offset by the
   same leading-whitespace delta; the delta is re-applied to `newString` lines on replacement.

Rules:

- Rungs 2–3 run only when rung 1 finds zero matches and `replaceAll` is false (D4). If a relaxed
  rung finds 2+ matches, fail with the existing ambiguity error.
- When a relaxed rung fires, the replacement uses the file's actual matched text as the boundary
  and the tool output notes `(matched with whitespace tolerance)` so users and models see it.
- MultiEdit applies the ladder per edit; atomicity is unchanged.
- No similarity scoring / Levenshtein in v1 — deterministic transforms only.

Tests: each rung, ambiguity under relaxation, indent re-application on `newString`, CRLF files,
tab-vs-space, `replaceAll` bypasses relaxation, diff-note presence.

### 1.6 Enforce read-before-edit

`src/tools/file-provenance.ts` gains `requireObservationForMutation()`: fail when the observation
ledger has **no entry** for the target (today `requireFreshObservation` silently passes in that
case — staleness is checked, existence of a prior read is not).

- Wire into `Edit` and `MultiEdit` unconditionally; into `Write` only when the target file exists.
  `ApplyPatch` unchanged (D7).
- Error: code `file_not_observed`, message
  `SKIPPED: <path> has not been read in this session. Call Read (or mention the file) before modifying it.`
- Verify during implementation that `@file` mentions and checkpoint freshness flows populate the
  ledger (they emit `fileObservations` artifacts); if any legitimate path reaches Edit without an
  observation (e.g., managed patcher bootstrap), fix that flow rather than weakening the check.

Tests: unit tests for the new guard; an agent-loop test that Read-then-Edit passes and blind Edit
fails; Write-to-new-file exempt; documented in CHANGELOG as a behavior change.

### 1.7 Identical-retry circuit breaker (advisory)

- Add a small per-session ring buffer (cap ~8) of failed-call signatures
  `sha256(toolName + stableStringify(arguments)) + errorCode` on the session runtime state (same
  home as `toolDiscoveryState` — no module-level state, per conventions).
- In `prepare()`/`executePrepared()`: when an incoming call's signature matches a recorded recent
  failure, execute normally but, on failure, replace the remediation with an escalation:
  `This exact call already failed with the same error. Do not retry identical arguments. Re-Read
  the target, adjust the arguments, or use a different tool.`
- Advisory only (D8); the buffer clears on session end and is capped, so memory is bounded.

Tests: registry test that a repeated failing call gets escalated remediation and a changed call
does not; buffer cap behavior.

## Phase 2 — Measurement

### 2.1 Per-session tool-failure counters

- Count `{tool → calls, failures by structured error code}` on session runtime state, incremented
  where the loop records tool results (`src/agent/loop.ts`).
- Persist as an additive optional field on the existing usage record (`src/types/sessions.ts`);
  `SessionStore.load()` already ignores unknown fields, so old sessions stay readable.
- Surface in the `/usage` overlay: a compact `Tool calls: N (M failed — Edit: 2 text_not_found,
  Grep: 3 invalid_arguments)` block. Managed-agent `metrics.jsonl` already records `toolCalls`
  and `retries`; add the failure-by-code map there for parity.

Tests: loop unit test with scripted provider producing failures; usage-record round-trip;
TUI render test for the overlay block.

### 2.2 Edit-reliability eval script

A deterministic, provider-hitting eval — **not** part of CI or `npm test`.

- Location: `scripts/edit-eval/` (fixtures + runner), `npm run eval:edit`.
- ~24 fixture tasks in a `mkdtemp` git repo, covering: unique exact replace; multi-occurrence
  requiring `replaceAll`; whitespace-sensitive target (tabs, trailing spaces); CRLF file; deep
  indentation; long line; multi-file change; new-file creation; deletion; rename-like edit;
  a task whose instruction quotes Read output *with* line-number prefixes (leakage trap).
- Runs the headless SDK (`query()`) against the configured model; success judged by
  string/regex predicates on resulting file content (no LLM judging).
- Output: JSON + markdown table to `.book/reports/edit-eval-<model>-<date>.md` with per-task
  success, attempts, failure codes, mutation tool chosen, and tokens.
- Purpose: baseline before Phase 1 lands, delta after, and per-model comparison for Phase 3.

## Phase 3 — Model-conditional mutation guidance

### 3.1 `editFormatFor()` in `src/models.ts`

```ts
export type EditFormat = 'patch' | 'replace' | 'whole';
export function editFormatFor(model: string): EditFormat
```

- Match on the lowercase final path segment of the model id (router prefixes like
  `9router/qc/qwen3.7-max` must not confuse it): `/gpt|codex|^o\d/` → `'patch'`; everything else
  (Claude, Qwen, GLM, Gemini, Grok, unknown) → `'replace'`. `'whole'` is reachable only via
  settings. That is the entire built-in table (D3).

Tests: router-prefixed ids, gpt/codex ids, unknown ids default to `replace`.

### 3.2 Settings override

- Add `editFormat: z.enum(['patch', 'replace', 'whole']).optional()` to the existing
  `providerModelSchema` (`src/settings.ts:102`) — it already holds per-model metadata
  (`contextWindow`, `effort`, …), so this follows the established pattern.
- Resolution: settings `provider.<name>.models.<id>.editFormat` → else `editFormatFor(model)`.

### 3.3 Render guidance per format

`operatingPrinciplesSection()` in `src/agent/context.ts` takes the resolved format and swaps the
three mutation lines (currently `context.ts:300–302`):

- `patch` — current text (prefer ApplyPatch; Write for full replacement; Edit/MultiEdit fallback).
- `replace` — prefer Edit/MultiEdit for targeted changes; Write for new files or intentional full
  replacement; ApplyPatch for related multi-file changes where atomicity helps.
- `whole` — prefer Write with complete file content after Reading the whole file; never elide with
  placeholders; Edit available for very small changes.

The section stays in the cacheable static prefix — the format is fixed per (session, model), and a
`/model` switch already rebuilds the prompt. Tool descriptions do **not** vary by model (schema
stability and prompt-cache hygiene).

Docs: update the "ApplyPatch is the preferred source-mutation tool" wording in `CLAUDE.md` and
README "File mutations" to describe the conditional default and the settings override.

---

## Rollout and verification

Order: Phase 2.2 (baseline eval) → Phase 1 → re-run eval → Phase 2.1 → Phase 3 → re-run eval with
`qwen3.7-max` plus one GPT-family model. Each phase is a separate PR-sized change with its own
CHANGELOG entry.

Per phase: `npm run check` (format, lint, typecheck, architecture, unit, contract) plus the
targeted test files above. `npm test` before release. No new dependencies anticipated
(`stableStringify` can be a ~10-line local helper or reuse an existing one if present).

Acceptance criteria:

- A Claude Code–style call (`file_path`/`old_string`/`new_string`, Grep `glob`+`path`) executes
  successfully against Book's built-in tools.
- `invalid_arguments` failures name the allowed arguments.
- An Edit whose `oldString` differs only by trailing whitespace or uniform indentation succeeds
  with a tolerance note; ambiguous relaxed matches still fail.
- Edit/MultiEdit on a never-read file fails with `file_not_observed`; after Read it succeeds.
- A repeated identical failing call returns escalated remediation.
- `/usage` shows tool call/failure counts; the eval script produces a per-model report.
- With a GPT-family model the system prompt recommends ApplyPatch; with anything else it
  recommends Edit/MultiEdit; a settings override changes it.

## Risks

| Risk | Mitigation |
| --- | --- |
| Fuzzy rung edits the wrong site | Unique-match-only rungs, no similarity scoring, tolerance note in output, `replaceAll` excluded |
| Read-first breaks existing SDK/headless scripts that edit blind | Clear `file_not_observed` remediation; CHANGELOG breaking-change note; managed flows audited in 1.6 |
| Alias map collides with a future canonical arg | Canonical-wins rule already in `normalizeToolArguments`; aliases live in one reviewed table |
| Family regex misclassifies a routed model id | Match on final path segment only; settings override is the escape hatch; default is the safe `replace` |
| Grep `path` + `include` interplay surprises | `include` stays a filename filter, `path` a root scope; tests pin the combination |
| Guidance-line churn invalidates prompt cache | Format resolved once per session/model; line only changes when the model changes (which already rebuilds the prompt) |

## Non-goals

- No per-model tool exposure differences, no per-model tool descriptions.
- No hashline/line-anchored edit format, no LLM-assisted edit correction (candidates for a later
  evaluation via 2.2, or for the adaptive harness as workflow candidates).
- No automatic switching of edit format based on observed failures (adaptive-harness Phases 4–7
  territory).
- No renaming of canonical arguments and no changes to MCP tool handling.
- No hard blocking of repeated calls.

## Open questions for review

1. **1.6 strictness:** enforce read-before-edit for `Write` over existing files in the same change,
   or land Edit/MultiEdit first and Write in a follow-up after watching for friction?
2. **1.5 ladder depth:** ship rungs 2+3 together, or rung 2 (trailing whitespace) only and hold
   indent-shift until the eval shows it's needed?
3. **1.7 escalation:** is advisory-forever right, or should a third identical failure return
   `status: 'blocked'`?
4. **3.2 scope:** is the per-model settings override enough, or do you also want a top-level
   `editFormat` default (applies to whatever model is active)?
5. **2.2 corpus size:** is ~24 tasks acceptable for v1, or do you want the categories trimmed to
   ~12 to keep eval runs cheap on paid routers?
6. **`whole` format:** implement its guidance text now (trivial) even though nothing selects it by
   default, or drop `'whole'` from v1 entirely?

## Tracking

Implemented 2026-07-26 (single change set). Open-question resolutions applied: 1 — Write-to-existing
enforced in the same change; 2 — both ladder rungs shipped; 3 — advisory-only breaker; 4 — per-model
settings key only; 5 — 25-task corpus; 6 — `whole` guidance implemented. An additional finding was
fixed along the way: structured `remediation` text was never rendered into model-facing error
content; it now appears as a `Fix:` line (`src/tools/result.ts`).

A max-effort review pass (2026-07-27) confirmed and fixed 18 further findings on top of the
initial implementation, most notably: arguments are now normalized before hook/permission
evaluation (the ApplyPatch `input` alias could previously bypass path-scoped deny rules); the
exact-match Edit path no longer interprets `$` replacement patterns; observation keys are
case-folded on Windows; scoped portable Grep keeps root-anchored gitignore patterns effective;
NotebookEdit joined the read-first gate; child agents inherit parent observations; argument
aliases moved onto each ToolDefinition; and the relaxation ladder is abortable and rejects
inconsistent indent shifts.

| Item | Status |
| --- | --- |
| 1.1 Argument aliases | Implemented (`src/tools/registry-core.ts`) |
| 1.2 Grep `path` + `C` | Implemented (`src/tools/file.ts`) |
| 1.3 Allowed-args in errors | Implemented (`src/tools/registry-core.ts`) |
| 1.4 Edit error remediation + descriptions | Implemented (`src/tools/file.ts`, `src/tools/result.ts`) |
| 1.5 Fuzzy fallback ladder | Implemented (`src/tools/fuzzy-match.ts`) |
| 1.6 Read-before-edit | Implemented (`src/tools/file-provenance.ts`, `src/tools/file.ts`) |
| 1.7 Retry circuit breaker | Implemented (`src/tools/registry-core.ts`, `src/session/runtime.ts`) |
| 2.1 Tool-failure counters | Implemented (`src/agent/loop.ts`, `/usage` report + TUI card) |
| 2.2 Edit eval script | Implemented (`scripts/edit-eval.ts`, `npm run eval:edit`) |
| 3.1 `editFormatFor()` | Implemented (`src/models.ts`) |
| 3.2 Settings override | Implemented (`providerModelSchema.editFormat`) |
| 3.3 Conditional guidance | Implemented (`src/agent/context.ts`) |

# Ranking

The ranking function for `/next` pass 3. Assumes the north star in [SKILL.md](../SKILL.md): the
only question is whether a change makes the owner daily-drive Book instead of Claude Code.

## The three tiers

Rank by tier first, always.

- **1 — BLOCKER.** Cost, trust, crashes, latency. The test: *would this make the owner quit and go
  back to Claude Code?* Trust counts even when the fix is tiny — a security knob that silently
  does nothing is a trust failure, not a config gap. Shipped examples: prompt caching (cut input
  cost ~10x); sandbox argv containment (`407a0f8`). In flight, not shipped: deny rules holding in
  every permission mode (branch `fix/deny-rules-all-modes`, 1 commit ahead of main with an
  uncommitted working tree as of 2026-08-19).
- **2 — COMPLETENESS GAP.** A feature that exists in one host but not another, or is declared in
  docs but not wired. The test: *does the README promise it without a caveat?* If yes it is a gap,
  not a feature request. Book's dominant failure shape is TUI-only features.
- **3 — NEW CAPABILITY.** Genuinely new surface area. Almost never the right next step while any
  tier-2 item is open.

## Scoring a candidate

Produce all four. If you cannot, you do not understand the candidate well enough to rank it.

1. **Tier** — 1, 2 or 3, with the one-line test above actually answered.
2. **Size** — `hours` / `a day` / `more`, based on files touched, not ambition.
3. **Daily-drive delta** — what changes the next time the owner sits down with Book. If the answer
   is "nothing visible", it is tier 3 no matter what it touches.
4. **Trade-off** — the cost of doing it: coupling introduced, prompt budget spent, latency added,
   surface locked in. A candidate with no stated trade-off is a title, not a candidate.

**Ordering: tier ascending, then size ascending, then daily-drive delta.** Size orders *within* a
tier and never across one. A `more`-sized candidate is presented as its first `hours`/`a day`
slice inside its own tier; if it cannot be sliced it stays in its tier flagged `unsliceable` and
is disqualified from being the single recommended next step — it is **not** demoted below a lower
tier. Within a tier, bias hard toward small and completable.

## Worked examples

**Verified 2026-08-19 against a dirty working tree on branch `fix/deny-rules-all-modes`; line
numbers rot silently.** Every citation below carries its symbol or match string — re-run the grep
before you quote one. If the cited line no longer says what is claimed, that is evidence the item
shipped: **drop the example, do not repair it, do not carry it into the report.** These teach the
*shape* of a candidate. They are not a shortlist, and replaying them without re-verification is
the single cheapest way to turn pass 3 into a recital.

### Scored — use these to calibrate the four-part score

**Sandbox settings keys that are validated but never read.**
`sandbox.autoAllowBashIfSandboxed` (`src/settings.ts:17`) and `sandbox.allowUnsandboxedCommands`
(`src/settings.ts:19`) exist in the Zod schema and survive `book config set` (`sandbox` is a
top-level settings key derived from the schema shape in `src/settings-repository.ts`), but the
only bypass check — `matchesExcluded(command, ctx.sandbox.excludedCommands ?? [])` at
`src/tools/shell.ts:109` — reads `excludedCommands` only. Setting `allowUnsandboxedCommands: false`
is a silent no-op. (`MILESTONES.md` line ~49 tracks the approval side of the same escape hatch.)
→ **Tier 1** (trust: a security setting that lies), size `hours`, delta: the sandbox means what
the settings file says. Trade-off: wiring it fail-closed may break workflows that depended on the
no-op. This is the case where a tiny item outranks everything — tier is about consequence, not
effort.

**`/review` cannot run outside the TUI.** The effect is produced at
`src/commands/builtins.ts:632` (`return { type: 'review', scope }`) and handled only at
`src/tui/app.tsx:1529` (`effect?.type === 'review'`); `grep -rln 'review/orchestration.js' src/`
returns `src/tui/app.tsx` alone. `runSingleReview` (`src/review/orchestration.ts:135`) and
`runDeepReview` (`:229`) already take an injectable `runner: ReviewAgentRunner` (`:32`).
→ **Tier 2**, size `a day`, delta: review from headless and CI. Trade-off: needs a text/JSON
report renderer that then becomes a maintained output format.

**Plan mode is auto-rejected in print/headless/SDK.** `src/headless.ts:222` hardcodes approval to
`const approved = mode === 'bypassPermissions'`, so `book -p --permission-mode plan` loops the
`'SKIPPED: Plan was not approved.'` rejection in `src/agent/loop.ts` until `--max-turns`.
`onUserQuestionRequired` (`src/types/public-sdk.ts:51`) is the exact plumbing to copy.
→ **Tier 2**, size `hours`, delta: a documented flag stops silently failing. Trade-off: almost
none — it mirrors existing plumbing. Best size-to-tier ratio here; if the tier-1 above were done,
this is the pick.

### Unscored — score these yourself before using them

Facts only. Producing the tier, size, delta and trade-off for each is the exercise; if your score
does not fall out of the facts, go read the code rather than guessing.

- **Persistent background jobs only reattach in the TUI.** `configureWorkspace` is called once, at
  `src/tui/app.tsx:364` (`resolved.configureWorkspace(liveConfig.workspace)`);
  `refreshPersistentJobs` (`src/jobs/shell-manager.ts:628`) only re-reads the in-memory map, so a
  headless `BashOutput` against a prior-run job returns `` `Shell ${shellId} not found` ``
  (`src/tools/shell.ts:271`) while the README promises reattachment. Note the 500 ms monitor
  interval at `src/jobs/shell-manager.ts:231` — it must not be left alive in one-shot runs.
- **Slash commands are TUI-only.** `resolveCommandBody` (`src/commands/resolve.ts:163`,
  re-exported at `src/commands/loader.ts:79`) has exactly one non-test consumer,
  `src/tui/app.tsx:62`; `src/cli/run.ts` passes `--print` straight through, so
  `book -p "/security-review"` sends the literal string to the model. Partial support would create
  a second, subtly different command semantics — ship the prompt-body subset or nothing.
- **`--scrollback` has no session, MCP, or slash commands.** `src/cli/scrollback.ts` handles
  `/exit` (`:54`) and `/clear` (`:55`) and nothing else, and `src/cli/run.ts` returns at the
  `runScrollbackSession` call (~`:227`) before the `SessionStore` (~`:232`) and the
  `McpSessionHost` (~`:275`) are built, so `--scrollback -c` silently does nothing while
  `README.md:108` lists the flag as a first-class host. Hooks *do* fire — scrollback calls
  `runAgentLoop` directly (`src/cli/scrollback.ts:6,41`) and SessionStart / UserPromptSubmit /
  PreToolUse / PostToolUse / Stop all run inside the loop. Closing a promise by narrowing it
  counts as closing it: consider rejecting the unsupported flags loudly and documenting the limit.
- **Drag-to-select copy in the TUI** — `origin/ui-copy-text`, ~59 commits behind main with real
  unmerged commits.

## Low conviction — the research trigger

The top-ranked candidate is low-conviction when any of these hold:

- it is **tier 3**;
- it is **config-knob shaped** — "make X configurable", "expose Y as a setting". The canonical
  Book example is the review threshold and timeouts: `DEFAULT_CONFIDENCE_THRESHOLD`
  (`src/review/types.ts:90`), `REVIEW_TIMEOUT_MS` (`src/review/orchestration.ts:70`) and
  `FIX_TIMEOUT_MS` (`src/review/fix.ts:34`) are compile-time constants with no settings key. Real,
  and a signal that the board is empty;
- its **daily-drive delta is "nothing visible"**;
- every remaining unchecked `MILESTONES.md` item is **gated on something else** — a stabilization
  window, a release, an upstream major.

When that happens, say so in one sentence and name `/next research`. Do not pad the shortlist to
hide it, and do not invent a tier-1 to avoid the nag.

## Reading plan status

Pass 1 step 6. `plans/` has **no parseable status convention** — do not build a parser. Read the
first ten lines only:

```bash
for f in plans/*.md plans/adaptive-harness/*.md; do
  printf '%-62s | ' "$f"
  head -10 "$f" | grep -m1 -E '^\s*-?\s*\*{0,2}(Current )?[Ss]tatus\*{0,2}:' || echo '(none)'
done
```

Three syntaxes (`- **Status:**` x19, `Status:` x2, `- **Current status:**` x1), free-text values,
all of it prose. All nine `plans/*.md` carry a status line; four
files under `plans/adaptive-harness/` carry none (`agent-capability-research`,
`external-evidence-2026-08`, `phase-1-capability-matrix`, `research-grounding`), so only
`plans/adaptive-harness/phase-*` is *syntax*-consistent. The `head -10` bound is what keeps five
`status: SomeType;` TypeScript-snippet lines out of the result — do not widen it. A stale plan
status is reported, never edited.

## Anti-patterns

- **Do NOT rank by what is nearly finished.** "Phase 6 is next" is plan-following, not direction.
- **Do NOT rank a whole plan phase.** Rank the smallest slice that changes what the owner
  experiences.
- **Do NOT count docs updates or test additions as candidates.** They are part of a candidate.
- **Do NOT surface more than five.** A shortlist that lists everything ranks nothing.
- **Do NOT quote a worked example above without re-running its grep.** See the header of that
  section.

# Research Lenses

Pass 4 of `/next`. Entered only by explicit `/next research`, or after the user accepts the
low-conviction nag from [ranking.md](ranking.md). Deliberately heavy: minutes, rare, intentional.
Web search is expected for lenses B and C.

**The primary failure mode of this pass is emitting forty shallow ideas and a link dump.** The cut
criterion and output contract below exist to prevent exactly that. Obey them literally.

## Before you search

```bash
ls docs/adr/ 2>/dev/null || echo '(no docs/adr yet — research has never resolved anything)'
grep -rn '^- \*\*Status:\*\*' docs/adr/ 2>/dev/null || true
```

Read the title and status of every existing ADR first. An idea already rejected by an ADR does not
re-enter the funnel unless something changed — and if it does, it must be flagged (see **ADR
writes**). If `CONTEXT.md` exists, use its glossary terms and do not drift to synonyms; if it does
not exist, proceed silently. Both conventions come from `docs/agents/domain.md`.

## The four lenses

Run all four. Each lens yields **at most two** survivors into the funnel — and **zero is a normal
result**. The cut criterion below takes the funnel down to 2-3 total.

### A. Flaw hunt — where Book breaks under real daily use

Friction, not bugs. The question is *what would make the owner quit*, not *what is incorrect*.

**Do not expect the session logs to answer this.** As of 2026-08-19 the JSONL under `$BOOK_HOME`
(default `~/.book/sessions/`) carried exactly five event types — `session_meta`, `user`,
`assistant`, `turn_checkpoint`, `local` — and greps for `file_not_observed`, `permission_required`,
`abort` and `retry` returned nothing across the whole store. Confirm with
`cat ~/.book/sessions/*.jsonl | jq -r .type | sort | uniq -c` before relying on it. It can tell you
how long sessions run (`turn_checkpoint` count per session) and which model and mode were used
(`session_meta`) — that is, how much a session cost, never why it hurt.

The load-bearing sources are:

1. the `### Fixed` blocks under `## [Unreleased]` in `CHANGELOG.md`, grouped by subsystem to find
   repeat offenders;
2. one real task driven through `npm run dev`, logging every moment you wanted to reach for Claude
   Code.

If you cannot attach a frequency to a friction claim, write **unmeasured** — never estimate one.

- **GOOD:** "Compaction firing mid-tool-loop and dropping file provenance shows up three times in
  the `### Fixed` blocks this cycle, and it cost me one manual `/clear` plus three re-reads in the
  live run. Per-session and compounding."
- **BAD:** "Error messages could be clearer." — no frequency, no cost, no mechanism.

### B. Competitive diff — Claude Code, Codex, Aider, Cursor, OpenHands

**Not a feature checklist.** The output is a judgement in one fixed shape:

> *X has `<thing>`; adopting it costs `<complexity | prompt budget | latency | coupling>`; it buys
> `<Y>`; RECOMMEND / REJECT.*

Prompt budget is a first-class cost in Book: anything that lands in the cached prefix re-bills the
whole conversation when it changes, and there are exactly three cache breakpoints. Say which
transport a borrowed idea would use — cached prefix, uncached system suffix, or `<session-state>`.

- **GOOD:** "Aider's repo-map gives the model a whole-repo symbol index up front. Cost: several
  hundred cached-prefix tokens per session plus an index rebuild on every git change — it would
  sit in the volatile zone and break prefix reuse. Buys: fewer blind Glob/Grep rounds on
  unfamiliar repos. REJECT — Book's ToolSearch plus a practical core already covers the common
  path at zero prefix cost."
- **BAD:** "Cursor has tab-completion, inline diffs, and multi-file edits; we could consider some
  of these." — three things, no cost, no verdict.

### C. Literature — agent behavior research

Scope: context degradation over long windows, tool-use failure modes, memory, verification and
self-critique. **Filter hard:** an item survives only if it maps to an experiment Book can
actually run. Book has five eval harnesses — `npm run eval:edit`, `eval:compact`, `eval:zero-mem`,
`eval:skills`, `eval:review` (`scripts/edit-eval.ts`, `compact-eval.ts`, `zero-mem-eval.ts`,
`skill-eval.ts`, `review-eval.ts`). If a finding cannot be measured by one of those or a cheap
sibling of one, it does not survive this lens.

- **GOOD:** "Result: retrieval accuracy degrades sharply for content in the middle of long
  contexts. Book's compaction keeps a middle summary band — testable by re-running
  `npm run eval:compact` with the band reordered to the tail. Half a day, no production change to
  measure."
- **BAD:** "Recent work suggests self-consistency improves reasoning; we might sample multiple
  times." — no Book-side experiment, no harness, no cost.

### D. Philosophy transfer — what new principle is worth adopting

Book already runs on principles that are enforced, not aspirational: *sort prompt content by
volatility, not by topic*; *`tui/` is a leaf of the import graph*; *no module-level mutable state*;
*no import cycles*; *entry points are never imported*; *no blocking child-process APIs*. Several
are machine-checked by `scripts/check-architecture.ts`.

This lens asks what **new** principle is worth adopting and what it would change. A principle
survives only if you can name at least one existing file it would change and one plausible future
change it would reject. Bonus if it is mechanically checkable.

- **GOOD:** "Principle: *a feature is not shipped until a non-TUI host can invoke it.* Changes:
  `/review` and slash-command resolution move out of `src/tui/app.tsx`; enforceable as an
  architecture check that fails when a command effect has exactly one handler and that handler is
  under `src/tui/`. Rejects: any future surface added TUI-first."
- **BAD:** "We should value simplicity." — not falsifiable, changes nothing.

## Cutting eight to three

The lenses are not commensurable, so the cut is explicit and ordered. `ranking.md`'s tier function
does **not** apply here — it ranks shipped work, not experiments.

1. **Decidability.** A candidate survives only if you can name the measurement that ends the
   argument: a specific eval run, a specific grep, a specific timing. Anything that cannot be
   settled is dropped, not softened.
2. **Cost.** Prefer `hours` over `a day` over `more`.
3. **Lens spread.** Prefer one strong survivor per lens over three from one lens.
4. **Tie-break** toward whichever touches a surface the owner used this week.

Candidates that do not make the cut are **not listed, not summarised, and not linked.**

## Output contract — 2-3 experiments, and nothing else

The entire pass-4 answer is **2 or 3 candidate experiments**. No preamble, no survey of what you
read, no "further reading", no link dump. At most two citations, inline, per experiment. Each
experiment is exactly:

```
### <Title>
Lens: <A flaw hunt | B competitive | C literature | D philosophy>
Hypothesis: <one sentence, falsifiable>
Experiment: <what you would run, and which eval or measurement decides it>
Cost: <hours | a day | more> + <prompt budget / latency / coupling implications>
Verdict: RECOMMEND — <why now> | REJECT — <what kills it>
```

A REJECT is a valid and valuable output. A pass that recommends all three is usually a pass that
stopped judging. **If every candidate is a REJECT**, say so in one line and name the single pass-3
tier-2 item you would do instead — never pad the list to avoid an empty result. If a candidate
contradicts an existing ADR, add the flag line below inside its block.

Then stop and ask the user which, if any, to resolve. **Do not start implementing an experiment.**

## ADR writes — draft, then confirm

Write an ADR **only when the user resolves a decision** (adopt or reject). Never on your own
initiative, never for an idea still in the funnel, and never as an automatic log of the pass —
rejections not worth an ADR are not worth persisting anywhere. There is no third log file.

- Path and naming follow `docs/agents/domain.md`: `docs/adr/NNNN-kebab-case-title.md`, four-digit
  zero-padded sequence, next number = highest existing + 1, first is `0001`. `docs/adr/` is
  created lazily, on the first write.
- The repo specifies no ADR **body** format, so match the `plans/` metadata style:
  ```markdown
  # ADR-0001: Title In Sentence Case

  - **Status:** Accepted | Rejected | Superseded by ADR-NNNN
  - **Date:** YYYY-MM-DD

  ## Context
  ## Decision
  ## Trade-off
  ## Consequences
  ```
- **Trade-off is mandatory.** An ADR without the cost of the decision is a note, not a record.
- Show the draft and ask: **"Write this to docs/adr/NNNN-\<slug\>.md?"** Never commit.

### Contradiction flagging

`docs/agents/domain.md` specifies this form verbatim; reproduce it rather than inventing one:

```
_Contradicts ADR-0007 (example decision) — but worth reopening because…_
```

Reference form is `ADR-NNNN`. This is also the guard against re-proposing something already
rejected: if the reason the ADR gave still holds, drop the candidate and say so in one line
instead of spending an experiment slot on it.

---
name: next
description: Project direction for the Book repo — audits real harness state, reconciles local branches and open PRs, and ranks what to build next against one criterion, does it make Book daily-drivable instead of Claude Code. Use for "/next", "what should I do next", "what is the state of the project", or "/next research" for the heavy flaw-hunt / competitive / literature pass. Not for resuming an in-progress edit, and not for reviewing code — use /review for that.
allowed-tools: [Read, Grep, Glob, Bash, Write, WebSearch, WebFetch]
disable-model-invocation: true
---

# Next

Orientation for Book at the level of product direction. Every judgement answers one question:
**does this make the owner daily-drive Book instead of Claude Code?** Nothing else is the goal —
not backlog burn-down, not plan-phase completion.

Run everything from the repo root. Report in prose and short lists. **Never paste raw tool output
as the answer.**

## Modes

- **Default (`/next`)** — passes 1, 2, 3. Budget: roughly 15 tool calls. Pass 2 is nearly free
  (git + gh). Pass 1 is cheap when `docs/current-state.md` is fresh; when it is stale, pass 1 gets
  **bounded, not expanded** — obey the caps in step 3.
- **Research (`/next research`)** — pass 4 only. Minutes, rare, web search allowed. See
  [references/research-lenses.md](references/research-lenses.md). Never run it automatically; it
  is entered by explicit request, or after the user accepts the **Research trigger** nag.

## Pass 1 — State of the harness

Reality, not docs. Classify each surface **shipped-and-solid** / **shipped-but-thin** /
**declared-in-docs-but-not-wired**.

**1-2. Find the snapshot date and measure the drift.** The date is not a labelled field — it sits
in the L3 prose (`...snapshot for Book as of YYYY-MM-DD.`) and repeats in the final Verification
paragraph. Pin everything to `main`; HEAD is often a feature branch and the two answers diverge.

```bash
SNAP=$(grep -m1 -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' docs/current-state.md); echo "$SNAP"
BASE=$(git rev-list -1 --before="${SNAP}T23:59:59" main)  # T23:59:59, else the diff swallows the
git log --oneline --since="$SNAP" main | wc -l            # commit that authored the snapshot
git diff --stat "$BASE"..main -- src/ docs/ README.md | tail -1
git diff --name-only "$BASE"..main -- src/ | grep -vE '\.test\.tsx?$' \
  | cut -d/ -f1-2 | sort | uniq -c | sort -rn | head
```

**3. Branch on size. This is the cost control — obey it literally.**

- **Fewer than ~25 changed non-test files under `src/`** → the snapshot *is* your state. Read it,
  stop auditing, go to pass 2.
- **~25 or more** → verify **at most three** surfaces: the top rows of the hotspot list above,
  intersected with what `docs/current-state.md` actually claims. Report every other surface
  `unverified-this-run`.
- **More than ~30 commits stale** → say so in one line, run passes 2 and 3 normally, and offer the
  `current-state.md` refresh as a **separate follow-up invocation**. Never attempt a 100-file audit
  inside a one-minute budget. (On 2026-08-19 the snapshot was 2026-08-04: 73 commits and ~121
  changed non-test source files behind. Expect this branch until a refresh lands.)

**4. Verify a surface.** Two probes; pick by shape.

- *Command-shaped surfaces only* (a slash command or command effect) — batch them into one call:
  ```bash
  grep -rn "'review'\|'compact'" src/headless.ts src/sdk.ts src/cli/run.ts src/tui/app.tsx
  ```
  Hits only under `src/tui/app.tsx` → **declared-in-docs-but-not-wired**.
- *Everything else* — caching, providers, MCP, sandbox backends, tool capabilities. Most of
  `current-state.md` is this shape and the grep above returns **nothing** for it. Verify by
  importer instead:
  ```bash
  grep -rln 'review/orchestration.js' src/ --include=*.ts --include=*.tsx | grep -v test
  ```
  Zero importers outside `src/tui/` → TUI-only. **Zero importers anywhere means your search term
  is wrong, not that the feature is missing** — never classify off an empty grep without a second
  term.

**5. Grade what you verified.**

- **shipped-and-solid** — non-TUI handler, *and* co-located tests (`ls src/<area>/*.test.ts`),
  *and* no README/code mismatch.
- **shipped-but-thin** — non-TUI handler exists, but one of: no co-located tests; the README
  promises it without the caveat the code enforces; reachable from only one of {TUI, headless, SDK}.
- **declared-in-docs-but-not-wired** — as step 4. This is Book's dominant failure shape.

**6. If you need plan status, do not build a parser.** `plans/` has no parseable convention; the
bounded scan and what it actually shows are in
[references/ranking.md](references/ranking.md#reading-plan-status).

**Side effect:** draft a refreshed `docs/current-state.md`, scoped to what you actually verified.
See **Writes**.

## Pass 2 — Branch and PR reconciliation

Pure git and gh, so it is cheap. Nobody runs this pass; sediment accumulates.

```bash
git fetch --prune
git status --short
CUR=$(git rev-parse --abbrev-ref HEAD); echo "current: $CUR"
git for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin \
  | grep -vxE 'origin|main|origin/main|origin/HEAD' \
  | while read -r b; do
      read -r behind ahead <<<"$(git rev-list --left-right --count "main...$b" | tr '\t' ' ')"
      printf '%-58s behind=%-4s ahead=%-3s cherry=[%s]\n' "$b" "$behind" "$ahead" \
        "$(git cherry main "$b" | cut -c1 | sort -u | tr -d '\n')"
    done
gh pr list --state open --json number,title,headRefName,isDraft,mergeable,statusCheckRollup \
  --jq '.[] | "#\(.number) \(.headRefName) draft=\(.isDraft) mergeable=\(.mergeable) checks=\([.statusCheckRollup[].conclusion] | group_by(.) | map("\(.[0])x\(length)") | join(","))"'
gh issue list --state open --json number,title,labels
```

The `grep -vxE` is load-bearing: `%(refname:short)` renders `origin/HEAD` as the bare string
`origin`, which otherwise reads as a real branch needing a verdict.

**Verdict per branch — first matching rule wins:**

0. **`$CUR`, or any branch with uncommitted changes** (`git status --short` non-empty) →
   **IN PROGRESS**. Report ahead/behind and issue no verdict. Never recommend merging the branch
   the owner is standing on.
1. **`ahead=0`** → already contained in main. **DROP**, local and remote. *This is the majority
   case* — 13 of 21 branches on 2026-08-19 — and it yields an empty `cherry=[]`, so it must be
   decided on the ahead count, never routed through `git cherry`.
2. **`ahead>0`, `cherry=[-]` only** → the patch is already in main (squash-merge). **DROP**.
3. **`ahead>0`, any `+`, behind fewer than ~10** → **MERGE**, or open a PR.
4. **`ahead>0`, any `+`, behind tens of commits** → **REBASE or DROP**. State the rebase cost and
   make the owner choose. Do not silently recommend keeping it.

**Verdict per PR:** every open PR inherits its `headRefName`'s verdict, then passes a CI gate — all
conclusions `SUCCESS` and `mergeable=MERGEABLE` → **MERGE**; any `FAILURE` → name the failing check,
no verdict; empty rollup → CI has not run, no verdict. A deliberately-closed major bump tracked as
an open issue is not sediment; leave it.

**Degradation.** `git fetch --prune` is the only write this skill performs and it needs the network.
If it fails, prefix the branch table with "remote state as of \<newest origin ref date\>, fetch
failed" and issue **no DROP verdicts**. If `gh` fails or is unauthenticated, say "PRs and issues
unavailable this run" and note that pass 3 lost a candidate source.

**Do not carry a branch inventory here** — it rots, and a wrong list is a worse prior than none;
the commands above *are* the inventory. Shape only (2026-08-19): ~21 branches needing verdicts,
most `ahead=0`; two genuinely unmerged feature branches, both tens of commits behind; two dependabot
PRs, both with failing checks that day; three unlabelled deferred-major issues.

## Pass 3 — Next work, ranked

Candidate sources, in order of signal: pass 1's not-wired and thin findings > open issues >
`docs/current-state.md` "Known Boundaries" > unchecked milestones
(`grep -n '^- \[ \] ' MILESTONES.md`, 19 of them today).

Rank strictly by tier: **1 BLOCKER > 2 COMPLETENESS GAP > 3 NEW CAPABILITY**.
**Read [references/ranking.md](references/ranking.md) before ranking** — the falsification test per
tier, the mandatory four-part score (tier / size / daily-drive delta / trade-off), and the
calibration examples live there. A candidate missing any of the four is a title, not a candidate.

Size orders **within** a tier and never across one. An `hours`-sized tier-3 never outranks a
`more`-sized tier-1: the tier-1 is presented as its first `hours`/`a day` slice, and if it cannot
be sliced it is flagged `unsliceable` and disqualified from being *the* recommended next step —
never demoted below a lower tier. Tier is about consequence, not effort.

Output — **3-5 candidates**, each in this shape:

```
T2 — <what it is> (a day)
  delta: <what changes the next time the owner sits down with Book>
  cost:  <the trade-off: coupling, prompt budget, latency, surface locked in>
```

then **one recommended next step**. A line with no tier prefix is not a ranked candidate. Then stop
and ask. Ten closed gaps make a harness feel finished; one more half-built phase makes it feel like
a prototype.

## Research trigger

Not a timer. Nag research when the **top-ranked** pass-3 candidate is low-conviction — any one of:
(1) it is tier 3; (2) it is config-knob shaped ("make X configurable", "expose Y as a setting");
(3) its daily-drive delta is "nothing visible"; (4) every remaining unchecked `MILESTONES.md` item
is gated on something else — a stabilization window, a release, an upstream major.

```bash
git log -1 --format='%ad' --date=short -- docs/adr/   # empty = research has never resolved anything
```

That date is **context for the sentence only** and is never itself a reason to nag. Say it once:
*"Best thing on the board is \<X\> — \<tier 3 / config-knob shaped / no visible delta / everything
left is gated\>, and research last resolved something on \<date | never\>. That is the signal to
run `/next research`."* Do not run it yourself.

## Writes — draft, then confirm

**Never auto-commit. Never `git commit`, `git push`, or `gh pr create`.** Two artefacts only;
there is no third log file.

**`docs/current-state.md`** — refreshed by pass 1. Preserve its *actual* shape:

- H1 plus H2 only, no H3; no checkboxes. The L3 intro paragraph under the H1 and the whole
  `## Verification` section stay **prose**; every other section body is `- ` bullets. Do not
  bulletise the prose.
- Update both date stamps: `...snapshot for Book as of YYYY-MM-DD.` in the L3 sentence, and
  `Local verification for this documentation audit (YYYY-MM-DD)` in the final paragraph.
- **Rewrite only the bullets whose surface you verified this run.** Carry the rest forward verbatim
  and append `(surfaces not re-verified this run: <list>)` to the L3 sentence.
- Do not copy the test-count claims forward unless you ran `npm run test:unit` and
  `npm run test:contract` this session. If you did not, replace that whole final sentence with
  `Local verification for this refresh (<date>): not re-run; use the commands above.`

Show what changes, then ask: **"Write this refresh to docs/current-state.md?"**

**`docs/adr/NNNN-title.md`** — only when pass 4 resolves a decision. Rules in
[references/research-lenses.md](references/research-lenses.md).

`MILESTONES.md`, `CHANGELOG.md`, and `plans/` are **read-only** here. If a checkbox or a plan
status is stale, say so in the report and leave it.

## Non-goals

- **Do NOT start coding or editing after recommending**, and **do NOT fix things you notice in
  passing** — one line in the report, then move on. Direction is the owner's call: stop and ask.
  (`allowed-tools` withholds Edit/MultiEdit/ApplyPatch/Task; `Write` exists only for the two
  sanctioned artefacts.)
- **Do NOT review code.** `/review` exists for that.
- **Do NOT dump file contents or raw tool output.** Every line is a judgement, not evidence.
- Do not resume the last edit; this operates on product direction, not on the working tree.

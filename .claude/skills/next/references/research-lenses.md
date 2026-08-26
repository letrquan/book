# Research Lenses

Use this only for explicit `$next research`. The goal is 2-3 decidable experiments, not a survey or
feature wishlist. Web search is expected where external evidence matters.

Before searching, read the titles and statuses of existing `docs/adr/*.md` files. If `CONTEXT.md`
exists, use its glossary. Do not revive a rejected decision unless some premise materially changed.

## Four lenses

Run all four, with at most two survivors from any lens. Zero is a normal result.

### A. Daily-use flaw hunt

Look for recurring friction that would make the owner stop using Book, not merely incorrect code.
Use, in descending order of signal:

1. user-reported friction from recent Book sessions;
2. repeated subsystems in the current `CHANGELOG.md` fixed entries;
3. reproducible failures or delays visible in current issues and harness evidence;
4. a bounded PTY-driven scenario when automation can reproduce the real interaction.

Do not launch an interactive TUI in a shell that cannot drive it. If experiential evidence is
missing, use `AskUserQuestion` for one concrete recent example or label the claim `unmeasured`.

Each survivor states frequency, user cost, and mechanism. Never estimate frequency.

### B. Competitive difference

Compare Claude Code, Codex, Aider, Cursor, or OpenHands only where the comparison changes a Book
decision. Judge one idea at a time:

```text
<product> has <mechanism>; adopting it costs <complexity/prompt budget/latency/coupling>;
it buys <specific Book outcome>; RECOMMEND or REJECT.
```

For prompt changes, identify whether the idea belongs in the cached prefix, uncached system suffix,
or per-turn session state and what cache invalidation it causes.

### C. Agent-behavior literature

Focus on context degradation, tool-use failure, memory, verification, and self-critique. A result
survives only if Book can measure it through an existing eval or a cheap sibling of one. Current
entry points include `eval:edit`, `eval:compact`, `eval:zero-mem`, `eval:skills`, and `eval:review`.

State the source result, the Book-specific hypothesis, the exact measurement, and the cost of the
experiment. Drop findings that cannot be falsified locally.

### D. Principle transfer

Propose a new engineering or product principle only if it:

- changes at least one existing Book file or boundary;
- rejects a plausible future implementation choice;
- is falsifiable, preferably mechanically checkable;
- is not already enforced by the architecture checks or current documentation.

Generic values such as “prefer simplicity” do not survive.

## Cut to at most 3

Apply these gates in order:

1. **Decidability** — name the measurement that ends the argument.
2. **Cost** — prefer `hours`, then `a day`, then `more`.
3. **Lens spread** — prefer strong candidates from different lenses.
4. **Current relevance** — break ties toward a surface the owner used recently.

Aim for 2-3 blocks, but return fewer when fewer candidates survive; never manufacture a slot.
Do not list candidates cut before full evaluation or provide a link dump.

## Output contract

Return each fully evaluated candidate as one block, with at most 3 blocks:

```text
### <Title>
Lens: <A flaw hunt | B competitive | C literature | D principle>
Hypothesis: <one falsifiable sentence>
Experiment: <specific run, grep, timing, or eval that decides it>
Cost: <hours | a day | more> + <prompt/latency/coupling implications>
Verdict: RECOMMEND — <why now> | REJECT — <what kills it>
```

Use at most two inline citations per block. A REJECT is valuable. If every evaluated candidate is
rejected, say so; do not switch into the default workflow or invent a recommendation.

Then ask which recommended experiment, if any, the owner wants to resolve. If none survived, stop
after reporting that. Do not run an experiment or write an ADR during this workflow; either action
requires a separate explicit request.

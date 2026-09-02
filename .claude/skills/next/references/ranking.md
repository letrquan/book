# Ranking

Use this for every `$next` ranking pass — the default board and any single-aspect run. The north
star is whether the change makes the owner more likely to daily-drive Book instead of Claude Code.

## Tiers

Rank by consequence before effort:

1. **BLOCKER** — a reliability, trust, security, latency, or cost failure that would make the owner
   abandon Book during real work.
2. **COMPLETENESS GAP** — Book or its documentation already promises the capability, but a host,
   path, boundary, or important failure case is missing.
3. **NEW CAPABILITY** — genuinely new product surface. It rarely outranks an unresolved tier-2 gap.

Falsification tests:

- Tier 1: would the observed behavior plausibly make the owner stop using Book now?
- Tier 2: can you point to an existing promise or partially shipped implementation?
- Tier 3: would removing the proposal leave every current promise intact?

Do not promote an internal refactor merely because it is important. Its user-visible reliability,
cost, trust, or workflow consequence determines the tier.

Craft findings tier the same way. A surface that misleads, buries state, or forces the same
decision repeatedly breaks that surface's implicit promise — that is T2 evidence, not polish. A
subtraction (removing an element, merging two surfaces, replacing a repeated prompt with a
default) is a first-class candidate; judge it by its countable session delta, never penalize it
for adding no capability. A craft candidate without a countable before/after cannot rank above
T3.

## Candidate score

Every candidate needs all five fields:

1. **Tier** — `T1`, `T2`, or `T3`, justified by the corresponding falsification test.
2. **Aspect** — what sourced it: `board` for inspector/issue/plan evidence, or the aspect file's
   name (`ui`, `harness`, …).
3. **Size** — `hours`, `a day`, or `more`, considering uncertainty and integration surface rather
   than file count alone.
4. **Daily-drive delta** — what becomes faster, safer, cheaper, more reliable, or newly possible in
   the owner's next Book session. For a craft candidate this is the countable before/after.
5. **Trade-off** — coupling, prompt budget, latency, compatibility, migration risk, or API surface
   that the change introduces or locks in.

A title without all five fields is not a ranked candidate.

Order by tier, then by the smallest completable slice, then by daily-drive delta. A large T1 remains
above a small T2, but present its first independently useful `hours` or `a day` slice. If no such
slice exists, mark it `unsliceable` and do not choose it as the single recommendation.

## Candidate sources

Use current evidence in this order:

1. verified blocker, unwired, or thin findings;
2. findings from this run's aspect review;
3. active PR or branch work that needs a bounded finishing slice;
4. open issues;
5. `docs/current-state.md` known boundaries;
6. unchecked milestones and plans.

Do not rank a whole phase, documentation-only cleanup, or tests by themselves. Documentation and
tests belong inside the product change they validate.

## Output

Return 3-5 candidates in this form:

```text
T2 — <smallest useful slice> (a day)
  aspect: <board | ui | harness | …>
  delta: <change in the next real Book session; countable for craft candidates>
  cost:  <specific trade-off>
```

Name the strongest candidate from each source examined (the board and the run's aspect), then
name one overall recommendation and why it wins now.

## Research trigger

Recommend `$next research` instead when the top candidate remains low-conviction because any of
these are true:

- it is tier 3;
- it is mainly a configuration knob;
- its daily-drive delta cannot be stated concretely;
- all remaining work is gated on releases, stabilization windows, or upstream decisions;
- two candidates are close and evidence, rather than preference, could decide between them.

Do not invent a blocker to avoid admitting the board is uncertain.

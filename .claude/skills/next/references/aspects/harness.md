# Aspect: Harness

How well Book drives the model — the quality of the agent itself, independent of any feature.

Disambiguation: `src/harness/` (the adaptive-harness subsystem, inert while `harness.mode` is
`off`, with its own phase plans) is **not** this aspect; it is a project tracked on the product
board. This aspect reviews the live agent path.

## Scope

- The system prompt and its cache zones (`src/agent/context.ts`): volatility ordering, what the
  cached prefix and per-turn `<session-state>` actually spend tokens on.
- Compaction fidelity and the Carried Ledger: what survives a generation, what the baselines say.
- Tool ergonomics as the model sees them: names, descriptions, result framing, error text. Judge
  the rendered text, not the code that builds it.
- Permission friction: asks per session that a better rule, default, or capability boundary would
  remove.
- Continuation, stall, and retry behavior; token and cost efficiency; and the eval coverage of
  all of the above.

## Evidence

- Prefer measurements over readings: the eval entry points (`eval:edit`, `eval:compact`,
  `eval:skills`, `eval:review`), `FIDELITY_ARMS` in `src/agent/compact-fidelity.ts`,
  `book tool-stats`, and real session transcripts or `BOOK_DEBUG*` logs when present.
- Reading a prompt or tool description and judging it is allowed — but quote the model-visible
  text being judged.
- Recurring fix themes in `CHANGELOG.md` and closed issues are frequency evidence; a single bad
  transcript is an anecdote until reproduced.

## The questions

1. What does the model see that a ruthless editor would cut? Tokens are attention: every cached
   or per-turn line must earn its place, and the cached/uncached split must match volatility.
2. Where does a real session lose turns — retries, refused tools, permission asks with an
   obvious answer, tool results that bury the signal in framing?
3. What does the agent forget that the user already said, and what do the fidelity baselines say
   about it?
4. Which of these has an existing eval, and what did it last measure? A hypothesis with a cheap
   measurement outranks a grander one without.

## Output

Produce 0-3 candidates in ranking.md's block form with `aspect: harness`. Each names its
measurement — an existing eval, a countable prompt/token delta, or a reproducible transcript —
or is labeled `unmeasured` and cannot rank above T3. Zero candidates is a valid result.

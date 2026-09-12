# Benchmarking Book

Tooling for measuring Book against the public coding-agent benchmarks, in
particular the three components of the [Artificial Analysis Coding Agent
Index](https://artificialanalysis.ai/agents/coding-agents).

Artificial Analysis runs the index itself and does not accept third-party
submissions, so what you can do is **reproduce the same benchmarks locally**
and compare against their published numbers. All three components are public,
and all three run on [Harbor](https://www.harborframework.com) — so the one
adapter in [`harbor/`](./harbor) covers the whole index.

## The index

| Component                        | Tasks | What it measures      | Dataset                                                                                  |
| -------------------------------- | ----- | --------------------- | ---------------------------------------------------------------------------------------- |
| Terminal-Bench 4.0               | 66    | Agentic terminal use  | `terminal-bench/terminal-bench` on the Harbor hub                                          |
| DeepSWE v1.1                     | 113   | Long-horizon SWE      | [`datacurve-ai/deep-swe`](https://github.com/datacurve-ai/deep-swe)                        |
| SWE-Atlas-QnA                    | 124   | Repository Q&A        | [`scaleapi/SWE-Atlas`](https://github.com/scaleapi/SWE-Atlas)                              |

Per [Artificial Analysis' methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking):
each component is scored `pass@1` averaged over **three attempts per task**
(`-k 3`), the index is the equal-weight average of the three, and attempts that
exceed the time limit or trigger a safety refusal score zero. Cost, token usage
(input / cache / cache-write / reasoning / output), and wall-clock time are
reported alongside; missing telemetry is excluded rather than counted as zero.

Terminal-Bench 4.0 also runs reward-hacking detection: an attempt is voided if
the agent edits tests or graders, reads a bundled reference solution, fetches
the expected output from outside, or prints a graded value it never computed.

## Setup

Docker (or another Harbor environment backend) must be running.

```bash
uv venv && source .venv/bin/activate
uv pip install harbor
uv pip install -e benchmarks/harbor
export ANTHROPIC_API_KEY=...        # or BOOK_API_KEY / OPENAI_API_KEY
```

Smoke-test the install path before spending anything — this builds a task
container, installs Book, and exits without a model call:

```bash
harbor run -d terminal-bench/terminal-bench -a book_harbor:BookAgent \
  -m anthropic/claude-opus-5 -l 1 -n 1 --install-only
```

## Terminal-Bench

```bash
harbor run \
  -d terminal-bench/terminal-bench \
  -a book_harbor:BookAgent \
  -m anthropic/claude-opus-5 \
  -k 3
```

`-d terminal-bench/terminal-bench` is the 66-task set reported as Terminal-Bench
4.0; `-d terminal-bench/terminal-bench-2` is the older 89-task set. Add
`-l 5 -n 2` to sample a handful of tasks at low concurrency while iterating.

## DeepSWE

DeepSWE ships Harbor-compatible tasks and its own Harbor-compatible runner,
[Pier](https://github.com/datacurve-ai/pier). Point either at the task
directory:

```bash
git clone https://github.com/datacurve-ai/deep-swe
harbor run -p deep-swe/tasks -a book_harbor:BookAgent -m anthropic/claude-opus-5 -k 3
```

## SWE-Atlas-QnA

SWE-Atlas runs on Harbor with Modal sandboxes and grades rubrics with a judge
model. Follow its README for the judge credentials and the
`HARBOR_AGENT_ALLOWED_HOST` allowlist (which is what stops an agent from
looking the answer up), then substitute this adapter for the agent in one of
its `run_config/` scripts.

## Reading the results

Each trial directory holds:

- `agent/book.jsonl` — Book's raw stream-JSON transcript
- `agent/trajectory.json` — the ATIF trajectory Harbor reports from
- `agent/book-home/` — Book's `BOOK_HOME` for that trial: session JSONL, run
  records, tool-use telemetry
- `result.json` — `agent_result` carries tokens and cost; `verifier_result`
  carries pass/fail

`harbor view <jobs-dir>` opens the job; the job-level `result.json` rolls up
`pass_at_k`, token totals, and cost across trials.

## Interpreting a comparison

Two things make a local number not directly comparable to the published index:

- **Scaffold.** Artificial Analysis runs each agent in its own published
  harness configuration. This adapter runs Book in print mode with
  `--permission-mode bypassPermissions` and Book's own defaults for effort and
  turn limits — a deliberate choice, not a tuned one. `--ak effort=...` and
  `--ak max_turns=...` change it.
- **Cost.** Book prices a run from its own pricing table
  (`src/pricing.ts`), and reports `costStatus: "unknown"` for a model it does
  not know — which surfaces as an absent cost rather than a zero. Check
  `agent_result.cost_usd` is populated before comparing dollars.

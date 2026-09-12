# book-harbor — Harbor agent adapter for Book

Runs the Book CLI as an agent under [Harbor](https://www.harborframework.com),
the harness behind Terminal-Bench. Terminal-Bench is one of the three
components of the [Artificial Analysis Coding Agent
Index](https://artificialanalysis.ai/agents/coding-agents); see
[`../README.md`](../README.md) for the other two.

## Install

Docker (or another Harbor environment backend) must be running.

```bash
uv venv && source .venv/bin/activate
uv pip install harbor
uv pip install -e benchmarks/harbor
```

## Run

```bash
export ANTHROPIC_API_KEY=...          # or BOOK_API_KEY / OPENAI_API_KEY
harbor run \
  -d terminal-bench/terminal-bench \
  -a book_harbor:BookAgent \
  -m anthropic/claude-opus-5 \
  -k 3
```

- `-d terminal-bench/terminal-bench` is the 66-task set Artificial Analysis
  reports as Terminal-Bench 4.0. `-d terminal-bench/terminal-bench-2` is the
  older 89-task set.
- `-k 3` matches the index's three attempts per task.
- `-l 1 -n 1` runs a single task serially — use it for a first smoke test.
- `--install-only` builds the container and installs Book without running a
  task or spending a token. Do this before a full run.

## Options

Pass with `--ak key=value` (`harbor agent schema book_harbor:BookAgent` prints
the full schema):

| Option            | Default              | Purpose                                                            |
| ----------------- | -------------------- | ------------------------------------------------------------------ |
| `effort`          | Book's default       | `low` \| `medium` \| `high` \| `xhigh` \| `max`                     |
| `max_turns`       | Book's default       | Cap on agent turns                                                  |
| `permission_mode` | `bypassPermissions`  | Benchmarks are unattended; nothing can answer a permission prompt   |
| `package`         | `@letrquan/book`     | npm spec to install — point at a `.tgz` to benchmark a local build  |
| `provider`        | inferred             | Force `BOOK_PROVIDER` (`anthropic` \| `openai` \| `auto`)           |
| `version`         | `latest`             | Published version to install                                        |

To benchmark an unpublished build:

```bash
npm pack                      # → letrquan-book-0.2.0.tgz
harbor run ... -a book_harbor:BookAgent \
  --ak package=/path/to/letrquan-book-0.2.0.tgz
```

## How it maps onto Book

| Harbor                     | Book                                                        |
| -------------------------- | ------------------------------------------------------------ |
| `-m provider/model-id`     | `BOOK_MODEL=model-id`, `BOOK_PROVIDER` from the prefix        |
| resolved API key           | `BOOK_API_KEY`                                                |
| resolved base URL          | `BOOK_BASE_URL` (Book normalizes a trailing `/v1` itself)     |
| task instruction           | `book -p <instruction> --output-format stream-json`           |
| trajectory / ATIF          | parsed from the stream-JSON transcript (`book.jsonl`)         |
| cost and token totals      | `accounting.inclusiveUsage` / `accounting.inclusiveCostUsd`   |

The *inclusive* totals are used deliberately: Book's top-level `usage` omits
what managed agents and subagents spent, which is most of the money in a run
that delegates.

## Artifacts

Each trial's `logs/agent/` directory holds:

- `book.jsonl` — Book's raw stream-JSON transcript
- `trajectory.json` — the ATIF conversion Harbor reads
- `book-home/` — Book's `BOOK_HOME` for the run (sessions, memory, settings)

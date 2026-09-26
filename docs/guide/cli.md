# Command line, print mode, and the SDK

How to run Book from a shell, a script, or your own program.

## Command examples

```bash
# Interactive TUI mode
book

# Print mode (non-interactive)
book -p "What does this codebase do?"

# Headless JSON output
book -p "Refactor auth module" --output-format json

# Stream JSON (CI-friendly)
book -p "Run tests" --output-format stream-json

# Resume a previous session
book --resume <id-or-name>
book --continue  # most recent session in current directory

# Diagnose setup / edit settings from the shell (these run without a configured credential)
book doctor
book doctor --no-settings  # skip every settings layer, when one of them is what is broken
book config list
book config get permissions.deny
book config set permissions.allow '["Read(*)","Glob(*)","Grep(*)"]'  # user-global by default
book config set --local permissions.allow '["Read(*)"]'              # just this checkout
book config list --local                                             # what this checkout overrides
book config unset --local permissions.allow                          # drop the override

# Manage MCP servers (JSON shape is compatible with the wider MCP ecosystem)
book mcp list
book mcp add github npx -- -y @modelcontextprotocol/server-github
book mcp add remote https://mcp.example.com/mcp --transport http --scope project \
  --header 'Authorization=${GITHUB_TOKEN}'
book mcp get github
book mcp remove github

# Inspect and measure tool use recorded across sessions
book tool-stats
book tool-stats --json          # machine-readable aggregate
book tool-stats --all           # ignore the retention window
book tool-stats --since 7       # only the last 7 days
```

Each per-model row names the provider the model was reached through (`9router/cmc/stealth/x`) and
its error codes, and malformed arguments are counted by shape:
`invalid_json_arguments:truncated_start` is a route dropping a call's first fragment, not the model
writing bad JSON.

## Common flags

| Flag                                  | Purpose                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `-w, --workspace <path>`              | Workspace root (default: cwd)                                                                                                   |
| `-m, --model <model>`                 | Model override                                                                                                                  |
| `-p, --print [prompt]`                | Non-interactive / CI mode; the prompt may also be the one positional argument                                                   |
| `--output-format <fmt>`               | `text` \| `json` \| `stream-json`                                                                                               |
| `--input-format <fmt>`                | `text` \| `stream-json` (print mode input)                                                                                      |
| `--permission-mode <mode>`            | `default` \| `acceptEdits` \| `plan` \| `auto` \| `dontAsk` \| `bypassPermissions`                                              |
| `--effort <level>`                    | Thinking effort: `low` \| `medium` \| `high` \| `xhigh` \| `max`; outranks `BOOK_EFFORT`, `settings.effort`, and model metadata |
| `--provider <type>`                   | `anthropic` \| `openai` \| `auto`                                                                                               |
| `--max-turns <n>`                     | Cap agent turns (print mode)                                                                                                    |
| `--max-budget-usd <amount>`           | Cap spend (print mode)                                                                                                          |
| `--json-schema <schema>`              | Structured JSON output (print mode)                                                                                             |
| `-r, --resume <id\|name>`             | Resume a named/id session                                                                                                       |
| `-c, --continue`                      | Resume most recent session here                                                                                                 |
| `--session-id <uuid>`                 | Pin a session id                                                                                                                |
| `-n, --name <name>`                   | Display name for the session                                                                                                    |
| `--fork-session`                      | On resume, fork to a new session id                                                                                             |
| `--no-session-persistence`            | Do not write the session to disk                                                                                                |
| `--settings <path>` / `--no-settings` | Ad-hoc settings file, or skip all layers                                                                                        |
| `--scrollback`                        | Terminal-native scrollback instead of full-screen TUI                                                                           |
| `--agents <mode>`                     | `adaptive` (default) \| `manual` \| `off`                                                                                       |
| `--verbose`                           | Print mode: add each tool's result to the progress lines on stderr                                                              |
| `-q, --quiet`                         | Print mode: no progress lines on stderr                                                                                         |
| `--include-hook-events`               | Include hook lifecycle events in stream-JSON output                                                                             |
| `--include-partial-messages`          | Include partial assistant text deltas in stream-JSON output                                                                     |
| `--prompt-suggestions`                | Ask for follow-up prompt suggestions after completion                                                                           |

## Print mode

`-p/--print` runs one or more prompts with no terminal attached, for CI and scripting. The prompt
comes from the flag, from the one positional argument, or from stdin, so a long one need not be
interpolated into argv:

```sh
book -p "explain this repo"
book -p --model m "explain this repo"   # the positional is the prompt, in either position
book -p < prompt.txt
git diff | book -p            # the diff is the prompt
```

A prompt on the command line wins over stdin. Giving it twice, as the `--print` value and as the
argument, is an error rather than a silent choice, and a positional argument without `--print` is
an error too: the TUI has no initial prompt. `--input-format stream-json` reads stdin as newline-delimited
`{type:'user', content}` records instead, which is how you submit more than one prompt to a single
process.

In `text` output stdout is the final answer alone, and progress goes to **stderr**: one line per
tool call (`[Read] src/cli/doctor.ts`, `[Bash] npm test`), cut to the argument's first line and 120
characters, so a person watching a terminal can see a long run is alive without tailing the session
file. `--verbose` adds each call's result, naming its target, because a turn's call lines all print
before its results: `  → success 12ms src/cli/doctor.ts`, or `  → error 4ms missing.txt: File not
found: missing.txt`. A managed child's calls (through `Task`, `AgentSpawn`, or `/review`) print as
well, indented and named after the child's profile: `  [explorer] [Read] src/a.ts`, with
`    → success 3ms src/a.ts` under `--verbose`. `--quiet` turns the progress lines off, `retry:`
lines included.

The answer on stdout is the model's final answer: the text of the last turn that called no tools,
read past the prompts Book appends mid-run (`[continuation]`, `[work-state]`, the output-cap
resume). When the run stopped before the model answered again (a provider failure, a turn that was
only reasoning, or `--max-turns` reached on a turn that called tools), stdout stays empty rather
than repeating an earlier turn's narration. The exit status does not depend on the answer: a
`failed` outcome exits 1, and a run that stalled, timed out, or lost its connection exits 0 like a
completed one.

`json` and `stream-json` write no progress lines, but their stderr is not silent. `json` still
writes `retry:` lines (unless `--quiet`) and `error:` lines there; `stream-json` carries retries and
errors as `retry` and `error` records on stdout instead. Every format writes `warning:` lines (a
slash command whose shell substitution failed) and `⚠` startup notices to stderr. The SDK's
`query()` runs quiet: no progress or `retry:` lines reach the host's stderr, since every tool call
reaches it as an event, but `error:` and `warning:` lines still do.

A closed reasoning block the reply opens with (`<think>…</think>`,
`<reasoning_context>…</reasoning_context>`, several in a row, or an empty one) is stored as
reasoning, not answer text, and is not printed. Only blocks at the very start of the reply move.
A block ends at its first closing tag, and only when its shape leaves no doubt:

- it sits on one line, or its opening tag ends a line and its closing tag starts one (Book's own
  replay format, and DeepSeek/Qwen output);
- the closing tag ends its line, outside any code the block opened;
- no other reasoning tag appears inside the block.

An empty block (`<think></think>`) always splits. Otherwise the reply is left and printed exactly
as the model wrote it, reasoning included, rather than risk cutting answer text. A reply that
itself opens with an unfenced reasoning tag, such as a template, loses that block; fence or quote
the tag to keep it. A tag later in the answer is answer
text, and an answer with no such block is printed exactly as written, plus a newline. `stream-json` partial deltas
(`--include-partial-messages`) still carry the raw tags; the complete `assistant` record carries the
split content.

Three things behave differently in print mode, because there is nobody to ask.

**Slash commands.** A prompt beginning with `/name` is resolved through the same command
registries the TUI uses instead of being sent to the model as literal text. See
[Slash Commands](commands-and-skills.md#slash-commands) for the supported subset.

**Plan mode.** `--permission-mode plan` still refuses mutations until a plan is approved, and print
mode now has a way to approve one. `bypassPermissions` approves automatically, as before. A host
that supplied `onUserQuestionRequired` is asked through that same handler: one question with
`Approve` and `Reject` options, where any other free-text answer is taken as revision feedback and
the agent submits a new plan. With no handler there is nobody to ask, so the run **stops at the
first plan** and returns the plan as its deliverable — it no longer auto-rejects and lets the model
re-plan until `--max-turns` is exhausted. In `text` output the plan is printed followed by a line
saying nothing was applied; in `json` and `stream-json` the result payload carries:

```json
{
  "plan": {
    "status": "not_applied",
    "reason": "approval_unavailable",
    "plan": "the plan exactly as ExitPlanMode submitted it",
    "message": "No changes were applied: …"
  }
}
```

`reason` is one of `approval_unavailable` (no handler), `approval_declined`, `approval_cancelled`,
or `invalid_approval_response`. The run's terminal outcome is `completed`/`normal_completion` and
the process **exits 0** — "finished, and deliberately changed nothing" is expressed by
`plan.status`, not by an exit code. Under `stream-json` the decision is also announced as
`{"type":"plan_approval","status":"stop"}`; `status` is one of `approve`, `approve-fresh`,
`reject`, `revise`, or `stop`. Queued `--input-format stream-json` prompts after a plan stop are
not run. SDK `query()` callers see the stop through the forwarded `tool_use` event (the full plan)
and its `tool_result` (`structuredError.code = "plan_approval_unavailable"`); the `plan` object is
not yet carried on the SDK `result` event.

**Exit codes.** Print mode exits 1 when the run throws — a slash command this host cannot perform,
a command invoked with a bad argument, or a failure inside a host-performed command such as
`/review`. Everything else exits 0.

## SDK usage

```typescript
import { query } from '@letrquan/book';

for await (const event of query('Explain this code', {
  workspace: process.cwd(),
  onUserQuestionRequired: async (request) => ({
    action: 'answer',
    answers: Object.fromEntries(
      request.questions.map((question) => [
        question.question,
        question.multiSelect ? [question.options[0].label] : question.options[0].label,
      ]),
    ),
  }),
})) {
  if (event.type === 'text') process.stdout.write(event.content);
  if (event.type === 'tool_use') console.log('tool:', event.toolCall.name);
  if (event.type === 'result') console.log('usage:', event.usage);
}
```

`AskUserQuestion` supports 1-4 questions, described single/multi-select choices, and free-text answers in the TUI. Print mode emits `user_question` / `user_question_result` stream events and declines deterministically when no callback is supplied. When a callback is supplied, plan approval is routed through it as an ordinary question and emits the same two events; either way the decision is announced as `plan_approval`, whose `status` is one of `approve`, `approve-fresh`, `reject`, `revise`, or `stop` — see [Print mode](#print-mode). A slash command the host performed itself rather than sending to the model emits `command_result` (`{type, command, output, data}`) and is carried on the `result` event as `commandResults`. Managed workers additionally emit `agent_start`, `agent_update`, `agent_result`, `agent_question`, `evidence_update`, and `agent_apply`. Background shells emit `background_job_start`, `background_job_update`, `background_job_output`, `background_job_result`, and `background_job_dismiss` through stream JSON and the SDK. Host notices (such as saved memories or review candidates) emit `notice` (`{type: 'notice', message}`).

Auth and model selection come from settings / env (`BOOK_API_KEY`, `BOOK_MODEL`, and provider blocks), not from `query()` options. See `src/sdk.ts` for the full `QueryEvent` / `QueryOptions` surface.

For direct lifecycle control, create a manager with `createAgentManager(loadConfig(workspace))`; its public operations cover planning, spawning, listing, inspection, sending/resuming, waiting, stopping, evidence publishing/review, and validated application.

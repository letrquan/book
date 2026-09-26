# Tools, permissions, and safety

How Book reads and changes files, runs shell commands, and decides what it may do without asking.

## Reading files

`Read` returns a whole file by default, up to 2000 lines or 50 KB of output, whichever comes
first; `offset`/`limit` are for files larger than that. A Read that stops before the end of the
file ends with a notice naming where to continue, such as `[Lines 1-1163 of 1894 shown, the most
one Read returns (50 KB). Continue with offset: 1164.]`, so the shared 50 KB clip on tool results,
whose notice names a file in Book's `tool-output` directory that `Read` can open, never cuts a
Read. A line that fits under the clip on
its own is returned whole; a longer one is shown cut to fill it, and the notice gives the line's size
and points past it. `Read { filePath, outline: true }` is the survey call:
it returns only the lines that say what a file contains, each with its line number, so the model
can decide what to read in full.

- **Markdown** (`.md`, `.markdown`, `.mdx`): the `#`…`######` and setext headings, and nothing
  else. Fenced code blocks are skipped, so a `# comment` in a shell example is not taken for a
  heading. A leading `---` opens front matter, which is skipped, only when YAML runs up to a
  closing `---`: a `key:` line first, then `key:` lines (any text up to a colon), indented or `- `
  lines, and `#` comments. A `#` line after a blank line is a heading, so such a block is not
  front matter. Otherwise it is a horizontal rule, and the headings after it count.
- **Everything else**: every line at indentation zero except blank lines, comments, lines of
  closing punctuation alone (`}`, `});`, `]);`) and an Allman-style `{` line, plus lines indented
  by up to four spaces that declare something:
  - a `function`/`class`/`def`/`fn`/`fun`-style keyword line, unless the keyword is an object key
    or an import-list member (`enum: [...]`, `describe,`);
  - a method named first whose parameter list closes into a body, on the same line or a later one
    (`async *entries() {`, `#secret(): string {`, `async send(` … `): Promise<void> {`, or
    `}: Args): Promise<void> {` after a destructured parameter);
  - a method written return-type-first (`public int getN() {`, `Future<void> load() async {`),
    with its `{` at the end of the line or alone on the next, or with an expression body
    (`int Twice(int x) => x * 2;`); in Java and C#, also an interface or abstract method with no
    body (`double area();`);
  - an arrow-function member (`handle = (event) => {`).

  Lines shaped like these that are not declarations stay out: control flow (`if (`, `else if (`,
  `for (`, `foreach (`, `using (`, `lock (`, `switch (`, `catch (`; in Java and C# also with no
  space, as in `foreach(` and `lock(`, which elsewhere may be method names), `assert x;`,
  `return foo(`, `new Foo(`, `go func() {`, `defer func() {`, a call that closes into a callback
  (`useEffect(() => {`, `).then(() => {`), and a chained call (`foo(x).then(`). In `.ts`, `.mts`,
  `.cts`, `.mjs` and `.cjs` files, the text of a multi-line template literal is skipped at any
  indentation. `.tsx`, `.jsx` and `.js` files are not scanned for it, because JSX text may hold a
  `/*` or a lone backtick that would open a comment or template that never closes, and a scan
  that still ends inside one masks nothing. A `#` line is a
  comment in Python, shell, YAML, TOML, Ruby and PowerShell files, Makefiles, Dockerfiles (unless
  the name ends in a code extension, as `makefile.c` does), and extension-less scripts that start
  with `#!`; elsewhere C preprocessor lines and Rust attributes stay in.

- **What it covers:** these shapes fit TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin
  (declarations with `fun`; a `name(args) {` line there is a call taking a trailing lambda), C#
  (members at indentation 8 under a block-scoped `namespace X {`) and Dart. The supported shapes
  are the `Read outline contract` table in `src/tools/file.test.ts`. Not covered: C++ in-class
  members (`const std::string& name() const {`), Java inner-class members (indentation 8), a Dart
  constructor with no body, a plain `*values()` generator method (only `async *` is listed), a
  signature whose closing `)` shares a line with its last parameter, and PowerShell `<# … #>`
  block comments.

What an outline saves depends on the file: `src/agent/loop.ts` goes from 2876 lines to 51, and
this README goes to its 33 headings. A test file keeps its `describe`/`it` lines, and a JSON file
outlines to its opening brace. The outline is capped at 2000 entries or 50 KB, with a note naming
the line where the rest start. It takes no `offset` or `limit`, and passing either is an error.

An outline is not a read. It is recorded as its own `outline` observation, which satisfies
neither the observed-file check nor the freshness check. `Edit`, `MultiEdit` and a `Write` over an
existing file still need a `Read` first. An outline never replaces an earlier `Read` of the file
or its hash, and that still holds after a resume: a rebuilt ledger lets a real observation replace
an outline and never the reverse, whatever their timestamps, so a `Read` that finished before an
outline in the same parallel batch still counts. `ApplyPatch` checks its hunks against the file
itself, so after only an outline it proceeds as it would for any file not yet read. If the file
changed after an earlier `Read`, the patch is refused as stale even if the file was outlined since.

## File mutations

Book exposes the same mutation tools to every model — `ApplyPatch`, `Edit`, `MultiEdit`, and
`Write` — but the system prompt's recommended tool is **model-conditional**: GPT/Codex-family
models (trained on the V4A patch envelope) are steered to `ApplyPatch`, and every other model
(Claude, Qwen, GLM, Gemini, Grok, unknown) is steered to exact-replace `Edit`/`MultiEdit`, the
format with the best cross-model compliance in published evals. Override per model in settings:

```json
{ "provider": { "myrouter": { "models": { "qc/qwen3.7-max": { "editFormat": "replace" } } } } }
```

`editFormat` accepts `patch`, `replace`, or `whole` (whole-file `Write`-first guidance).

`ApplyPatch` accepts a compact Codex-style envelope:

```text
*** Begin Patch
*** Update File: src/example.ts
@@
 const answer = 41
-return answer
+return answer + 1
*** End Patch
```

Use `*** Add File: path` with `+`-prefixed lines for new files and `*** Delete File: path` for
deletions. Update hunks use exact, unique context; reread the affected range and regenerate the
hunk after a `patch_context_not_found` or `ambiguous_patch_context` error. Patches preserve an
existing file's LF/CRLF convention and UTF-8 BOM, validate all files before writing, verify the
post-state, and roll back earlier files if a later commit fails. Binary and mixed-line-ending
updates are rejected rather than guessed.

Mutation reliability guardrails, tuned for heterogeneous models:

- **Read-before-edit is enforced.** `Edit`/`MultiEdit` (and `Write` over an existing file) fail
  with `file_not_observed` until the file has been Read or `@`-mentioned this session, and fail
  with `stale_file_observation` when it changed since last observed.
- **Whitespace-tolerant recovery.** When an exact `oldString` match fails, Book tries two
  deterministic relaxations — trailing-whitespace-insensitive and uniform-indent-shift — and
  applies one only when it matches a single location; the result notes the tolerance used.
  `replaceAll` always requires exact matches.
- **Cross-harness argument aliases.** Claude Code-style spellings (`file_path`, `old_string`,
  `new_string`, `replace_all`, Grep `glob`/`-A`/`-B`/`-C`, ApplyPatch `input`) are normalized to
  Book's canonical arguments before validation, and `invalid_arguments` errors list the allowed
  argument names.
- **Malformed-JSON arguments.** A call whose arguments are not valid JSON fails with
  `invalid_json_arguments`. The error names the parse error and its position and asks for the whole
  call to be resent, rather than reporting schema errors about arguments the model did send.
- **Retry-loop braking.** Repeating a call that already failed with identical arguments returns
  escalated guidance instead of the same error; structured `Fix:` remediation lines are rendered
  into the model-facing error text.
- **Reliability visibility.** `/usage` shows per-tool call and failure counters for the session,
  and `npm run eval:edit` runs a deterministic ~25-task edit-reliability eval against the
  configured model, writing a report to `.book/reports/`.

`npm run eval:compact` runs a real-provider paired benchmark for `/compact`. Every probe runs
against the original history and the compacted history, so the report can separate baseline model
errors from compaction regressions. The default `--suite smoke` keeps the original five low-cost
static-recall probes. `--suite standard` runs 11 probes spanning static recall, knowledge updates,
conflict resolution, temporal reasoning, multi-hop synthesis, and abstention. Evidence is placed
early, late, or across the synthetic history, which remains larger than 6,000 estimated tokens.

The V2 report includes per-model and per-category accuracy, retained baseline answers, regressions,
improvements, JSON/tool protocol failures, compression ratio, prompt and net-token savings,
measured cost savings when model pricing is known, and token/cost break-even estimates that include
the one-time compaction call. Reports are written to `.book/reports/compact-eval-v2-*.{json,md}`.

```bash
npm run eval:compact -- --model 9router/qc/qwen3.7-max --suite smoke
npm run eval:compact -- --models 9router/ag/gemini-3.6-flash-high,9router/qc/qwen3.7-max --suite standard
npm run eval:compact -- --model 9router/qc/qwen3.7-max --suite standard --repeat 3 --include-no-history
```

Use repeated `--model` flags or comma-separated `--models` for cross-model comparisons. `--repeat`
measures run-to-run stability, `--include-no-history` detects probes that can pass without evidence,
and `--probes <count>` or `--context-window <tokens>` constrains cost and context. Experiments can
set `--checkpoint-tokens <tokens>` to override the reducer output cap without changing the
production default; the JSON report records the requested cap, realized checkpoint size, and full
checkpoint. `--compact-effort low|medium|high|xhigh|max` overrides reasoning effort only for the
compaction call, making it possible to test a cheaper reducer while keeping probe models fixed.
`--compact-model <model>` routes only the compaction call through another configured model, so a
cheaper reducer or a higher-fidelity reducer can be evaluated independently from the probe model.
The benchmark requires configured provider credentials and is not part of CI.

`npm run eval:memory` measures whether memory helps the next session and stays safe. Each item is
a teaching session followed by a probe in a fresh session. The workspace is reset between the two,
so a probe can pass only through memory, never by reading what the teaching session edited. Every
item also runs with memory disabled (the baseline) on the same probe. Items cover explicit and
implicit saves, corrections, a buried convention, scoped requests and keyword traps that must _not_
be saved, facts already in `CLAUDE.md`, update, forget, and poisoned web and repository content.
Scoring reads the store and the probe's files, commands and answer, never the model's own claims.
The report (JSON + Markdown in `.book/reports/`) gives, per model: recall with and without memory
with a paired bootstrap interval, over-memory, under-memory, save precision, injection and
obey-poison rates, duplication of `CLAUDE.md`, and extra input tokens. Items are split `dev`/`test`;
tune prompts on `dev` and report `test`. Design and rationale: `plans/memory-improvement-plan.md`.

```bash
npm run build
npm run eval:memory                                   # test split, default models, 3 repeats
npm run eval:memory -- --models 9router/ag/gemini-3.8-flash-high --split dev --repeats 1
npm run eval:memory -- --only poison-web,poison-readme --concurrency 3
```

`Write` remains appropriate for generated or intentional full-file replacement. The
`apply_patch` provider alias maps to `ApplyPatch`; legacy tools are not silently reinterpreted.

## Permission rules and modes

`permissions.allow`, `permissions.ask`, and `permissions.deny` are matched against every tool call.
`deny` beats `ask`, and `ask` beats `allow`.

Permission _modes_ decide whether you are prompted; they never relax a `deny` rule. A rule in
`permissions.deny` blocks the matching call in every mode, including `auto` and
`bypassPermissions`, and it is evaluated before the prompt, so a denied call never reaches one.
Modes differ only in what happens to calls that no `deny` rule matched:

| Mode                | Unmatched calls                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`           | Checked against `allow`/`ask`, then prompted                                                                                                 |
| `acceptEdits`       | As `default`, but file mutations are approved without a prompt                                                                               |
| `plan`              | Read-only tools only; mutations are refused until you approve a plan                                                                         |
| `auto`              | Run without a prompt                                                                                                                         |
| `dontAsk`           | Refused except for the built-in always-allowed tools (`MemorySave`) — the mode never prompts, and a user `allow` rule does not exempt a call |
| `bypassPermissions` | Run without a prompt                                                                                                                         |

`plan` mode needs a host that can approve the plan the agent submits through `ExitPlanMode`. The
TUI prompts; print/headless and the SDK route the decision through `onUserQuestionRequired`, and a
host that supplies no handler ends the run with the plan itself rather than rejecting it — see
[Print mode](cli.md#print-mode).

## Hooks

`hooks.<event>` takes a list of `{ command, matcher? }` entries run in declaration order over a
JSON-over-stdio contract. Supported events:

| Event              | Fires                         | Awaited | Can change the outcome  |
| ------------------ | ----------------------------- | ------- | ----------------------- |
| `SessionStart`     | Session opened                | yes¹    | no                      |
| `UserPromptSubmit` | Before a prompt is sent       | yes     | block, or rewrite it    |
| `PreToolUse`       | Before each tool call         | yes     | block the call          |
| `PostToolUse`      | After each tool call          | yes     | rewrite the tool output |
| `PreCompact`       | Before compaction             | yes     | block compaction        |
| `PostCompact`      | After compaction              | yes     | no                      |
| `SubagentStart`    | Before each managed-agent run | yes     | no                      |
| `SubagentStop`     | After each managed-agent run  | yes     | no                      |
| `Stop`             | Once, after the agent stops   | no      | no                      |
| `SessionEnd`       | Session left                  | yes¹    | no                      |

¹ Awaited by the TUI and other multi-turn hosts; fire-and-forget on the one-shot SDK path.

`SessionEnd` receives `reason`: `exit`, `clear`, or `resume` from the TUI. A print or SDK run
reports one of these:

| `reason`     | When                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `completion` | The run completed, or ended on a stall or a dropped connection without failing                                       |
| `aborted`    | Its signal aborted before it completed: a cancel, an `AbortSignal.timeout`, or a `stream-json` reader that went away |
| `error`      | The run ended `failed`, or threw after `SessionStart` (for example on a missing prompt)                              |

It runs at most once per session, and never under the cancelled run's own signal. Print and SDK runs
also pass `status` and `stop_reason`, the run's terminal outcome
(`completed`/`normal_completion`, `timed_out`/`stream_stall`, `cancelled`/…), so a hook can tell a
stall from success. Ctrl+C on `book -p` cancels the run and runs SessionEnd with reason `aborted`; a
second Ctrl+C exits without waiting.

**Awaited is the property that costs you latency**, and it is not the same as being able to veto.
A slow `PostToolUse` hook cannot block anything, but it still delays _every tool call_ by up to its
runtime — hooks are capped at 10 s each and run sequentially in declaration order. Only
`UserPromptSubmit`, `PreToolUse`, and `PreCompact` can refuse the operation outright.

`matcher` filters `PreToolUse`/`PostToolUse` by tool call (`Bash(*)`) and `PreCompact`/`PostCompact`
by trigger. `PreCompact` receives `trigger`, `focus`, and, when the span about to be summarized
contains text addressed to a summarizer, `suspect_inputs`: a list of `{ eventRef, excerpt }`; exit
2 (or `{"action":"block","message":…}`) refuses the compaction and the TUI shows the message. For a
deferred compaction the hook runs when the summarizer starts on the snapshot, and again if the
judge rejects the checkpoint and Book compacts synchronously instead.

Hooks from your own layers (`~/.book/settings.json`, `.book/settings.local.json`, `--settings`)
run as written. A hook declared in a repository's checked-in `.book/settings.json` is withheld
until you approve it once per workspace: the decision is recorded in `~/.book/trust.json`, outside
the workspace, keyed by a fingerprint of the event, matcher, command, and env — edit any of those
and the hook asks again. Nothing the repository ships can write that store, so a clone cannot
approve its own hooks. Non-interactive runs skip unapproved hooks with a warning.

`book doctor` lists each withheld hook with everything the fingerprint covers — command, matcher,
and environment — because approval covers all of them: `npm test` carrying
`NODE_OPTIONS=--require ./payload.js` is not the `npm test` it looks like. Record the decision with

```bash
book trust hook <fingerprint>          # or --all-pending for every withheld hook
book trust hook <fingerprint> --reject # refuse it, and stop being re-offered it
book trust rule "Bash(npm run *)"      # the same, for a project-declared allow rule
book trust command deploy              # and for a project command that substitutes shell
```

All three take `--workspace <path>`; `book doctor` prints it for you when it is diagnosing a
directory other than the one you are in. Each invocation records one decision and leaves every
other decision — in this workspace and in every other — untouched.

`Stop` fires once when the agent stops, not once per provider turn — a task that takes twelve
tool-call turns still fires it once. It fires on cancellation too, which is usually the point of
having one. Subagents do not fire it: `Task` and managed agents run the same loop with your hook
config, and managed agents already report through `SubagentStop`. Like `SessionEnd`, `Stop` is
skipped when a run ends early through a blocked prompt, context overflow, an exhausted run budget,
or a provider stream error.

## Which shell `Bash` runs

Book picks one shell per session and tells the model which one it got, so the syntax the model
writes matches the interpreter that will parse it. On macOS and Linux that is the platform default,
`/bin/sh`. On Windows, Book resolves in this order and stops at the first hit:

1. `BOOK_SHELL`, then the `shell` setting — a name (`bash`, `pwsh`, `powershell`, `cmd`, `sh`) or a
   path to an executable. A request that cannot be found is reported by `book doctor` and the
   automatic order continues, rather than failing every command.
2. **Git Bash**, when Book was launched from one (`MSYSTEM` or a POSIX `SHELL` is set) — so the
   shell you see in your own terminal is the shell the model writes for.
3. **PowerShell 7** (`pwsh`), then **Windows PowerShell 5.1**.
4. Git Bash if it is merely installed.
5. `cmd.exe`, only when nothing else exists.

`shell` is honoured from `~/.book/settings.json`, an explicit `--settings` document, or the
environment only. A workspace file cannot set it and `book config set shell` refuses those scopes:
it names the program every command is handed to, so a repository that could set it would run a
binary it ships on your first command. `book doctor` prints the resolved shell and why it was
chosen.

PowerShell is driven with `-EncodedCommand`, because 5.1 re-parses a `-Command` argument and
silently strips embedded double quotes. Under 5.1, Book also merges the error stream and renders
each record as text: left alone, that shell serializes a redirected stderr as a CLIXML document, so
a failing `Get-Item` handed the model XML instead of `Cannot find path`. Exit codes follow the last
statement, as in bash.

## Shell command timeouts

A foreground `Bash` command is killed after **300000 ms** (five minutes) by default. The model can
raise that per call with the `timeout` argument, up to **600000 ms** — reach for it before a full
build or test suite rather than after the kill. It is validated like any other argument, so a value
outside the declared range is rejected rather than quietly ignored. Background commands ignore
`timeout` entirely and take `max_runtime_ms` instead.

`BOOK_TOOL_TIMEOUT_MS` overrides the default for every tool, `Bash` included, and where it is set it
is also the **ceiling** on what a single call may ask for: lowering it to 30000 caps a model that
asks for ten minutes, and a request above the limit in force is refused rather than quietly shrunk.
Raising it above 600000 raises the _default_ — which needs no argument to reach — but not the
per-call reach, since the schema publishes and validates 600000 as the maximum. Precedence is the
call's `timeout` (bounded by that ceiling), then a deliberate per-tool setting such as
`agents.checkTimeoutMs` or `agents.taskTimeoutMs`, then `BOOK_TOOL_TIMEOUT_MS`, then the tool's
default. No source can resolve past 2147483647 ms (~24 days), the largest delay a timer can hold;
beyond it Node silently fires after 1 ms.

The same resolution governs every tool that enforces a deadline of its own — `Bash`, `Check`,
`Task`, and `WebFetch`. Each declares its budget so the host's backstop outlasts it; when the two
are equal the backstop fires first and replaces the tool's report, including its output, with a
bare timeout. The backstop ranks a per-tool setting above `BOOK_TOOL_TIMEOUT_MS` exactly as the tool
does, so a lower blanket override cannot fire it ahead of `Check` or `Task`. A `timeout` argument
sets the host budget only for a tool that publishes one, so a stray value cannot pull the backstop
underneath a tool that times itself.

A killed command reports itself as killed rather than failed, and returns whatever it printed on
stdout and stderr before the kill. The two outcomes call for different next moves — retrying a
killed command identically is pointless; retrying with a larger `timeout` is not — so the failure
message names the deadline it hit and the ways past it.

## Bash sandbox

`sandbox.enabled` runs `Bash` commands inside [bubblewrap](https://github.com/containers/bubblewrap), which must be installed and is Linux-oriented; the sandbox is unavailable on Windows. When it cannot be created, `sandbox.failIfUnavailable` decides whether the command fails or runs unsandboxed. `sandbox.excludedCommands` skips the sandbox for matching commands, and sandboxed output is prefixed with `[sandboxed]`.

The sandbox gives the command fresh PID/IPC/UTS namespaces, a private `/tmp`, read-only system directories, all capabilities dropped, and a lifetime tied to the spawning process. Commands are spawned as a direct argument vector — never as a shell string — so the command text is parsed only by the shell running _inside_ the sandbox. Ordinary shell syntax (pipes, `&&`, redirection, substitution) works normally there.

**The workspace root is the only directory bound writable by default**, and it is bound regardless of the `workdir` argument. A sandboxed `Bash` call whose `workdir` falls outside the workspace is rejected rather than granted a wider mount; use `sandbox.filesystem.allowWrite` to add directories deliberately.

`sandbox.filesystem` adjusts the default mounts, applied after the workspace bind so they take precedence:

| Key          | Effect                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| `allowWrite` | Bind the path writable inside the sandbox                              |
| `denyWrite`  | Bind the path read-only                                                |
| `denyRead`   | Mask the path — an empty tmpfs for a directory, `/dev/null` for a file |

Entries may start with `~`. Paths that do not exist are skipped — bubblewrap rejects a bind with a missing source — and the skipped entries are reported once at startup and by `book doctor`, since a skipped rule is policy you might otherwise believe is active.

`sandbox.network` **fails closed**. Bubblewrap has no DNS or per-domain filtering, so it can only share or unshare the network as a whole. If `allowedDomains` or `deniedDomains` contains anything, Book cannot honour the rule as written and disables network access entirely for sandboxed commands, with a warning. Leave both empty to share the host network.

Two further keys decide what happens _around_ that boundary. Both are consulted on every `Bash`
call, and both answer the same question — will this exact command really execute inside a
namespace? — from one shared predicate, so they can never disagree about a command:

| Key                                | Default | Effect                                                                      |
| ---------------------------------- | ------- | --------------------------------------------------------------------------- |
| `sandbox.allowUnsandboxedCommands` | `true`  | Set `false` to refuse any `Bash` command that would run outside the sandbox |
| `sandbox.autoAllowBashIfSandboxed` | `true`  | Run a genuinely sandboxed `Bash` command without a permission prompt        |

`allowUnsandboxedCommands: false` covers all three ways a command escapes: sandboxing is turned
off, the command matched an `excludedCommands` pattern, or bubblewrap is missing on this platform.
The refusal names the setting _and_ the specific reason, so it is actionable rather than a bare
denial. Note that with `sandbox.enabled` at its default `false`, nothing is sandboxed and this key
therefore refuses **every** `Bash` command — it is meant to be paired with `sandbox.enabled: true`.
It does not require independent approval for an `excludedCommands` match; it only makes that bypass
refusable outright.

`autoAllowBashIfSandboxed` is deliberately the weakest thing in the permission stack. It replaces
only the _default_ ask — the prompt Book raises when nothing else matched:

- `permissions.deny` is evaluated first and is never softened by it.
- An explicit `permissions.ask` rule still prompts.
- If you wrote **any** `permissions.deny` or `permissions.ask` rule at all, the default ask stays
  and nothing is auto-allowed. A shell line is not a file path: one command can read a file, write
  another, reach the network, and chain three more behind `&&`, so a glob only matches the shapes
  you thought to write down. Configuring adjudication is read as "ask me about shell commands",
  and being sandboxed does not overrule that.
- It applies only to `Bash`, and only to the exact command text that will be executed.
- It grants no ability in `plan` mode: `Bash` is not a read-only plan tool, and plan mode refuses
  it independently of the permission verdict.
- It does nothing while `sandbox.enabled` is `false` (the default), because then no command is
  sandboxed.

`book doctor` prints the number of `excludedCommands` patterns and the **effective** state of both
keys, reporting `autoAllowBashIfSandboxed: true` as _inert_ whenever nothing can actually be
auto-allowed, so the reported policy never overstates the enforced one.

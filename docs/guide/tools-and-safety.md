# Tools, permissions, and safety

How Book reads and changes files, runs shell commands, and decides what it may do without asking.

## Reading files

`Read` returns a whole file by default, up to 2000 lines or 50 KB of output, whichever comes
first; `offset`/`limit` are for files larger than that, and both are integers of at least 1 — a
fractional or zero value is rejected as an invalid argument rather than printing `2.5: undefined`
or `0: undefined`. The numbered lines are
the file's own lines and nothing else: a final newline ends the last line rather than starting
another, so `a\nb\n` reads as `1: a` and `2: b` and a file of exactly one newline reads as its one
blank line, `1: `. A file with no lines at all returns the notice `[Empty file: 0 lines.]` rather
than an empty result, which would read as a call that produced no output.

A Read that stops before the end of the
file ends with a notice naming where to continue, such as `[Lines 1-1163 of 1894 shown, the most
one Read returns (50 KB). Continue with offset: 1164.]`, so the shared 50 KB clip on tool results,
whose notice names a file in Book's `tool-output` directory that `Read` can open in the same run,
never cuts a
Read. A line that fits under the clip on
its own is returned whole; a longer one is shown cut to fill it, and the notice gives the line's size
and points past it. `Read { filePath, outline: true }` is the survey call:
it returns only the lines that say what a file contains, each with its line number, so the model
can decide what to read in full.

- **Markdown** (`.md`, `.markdown`, `.mdx`): the `#`…`######` and setext headings, and nothing
  else. Fenced code blocks are skipped, so a `# comment` in a shell example is not taken for a
  heading. A leading `---` opens front matter, which is skipped, only when YAML runs up to a
  closing `---` (or `...`): the first line that is not a `#` comment is a `key:` line (any text
  up to a colon), and each run of lines between blank lines holds `key:`, indented or `- ` lines.
  `#` lines among the keys of the first run are comments, and so is a `#` line that opens the
  block or sits in a later run beside YAML identifier keys (`title:`). A `#` line alone in its
  run, or beside a label such as `Summary: …`, is a heading, so such a block is not front matter:
  a horizontal rule, and the headings after it count.
- **JSON** (`.json`, `.jsonc`, `.json5`, `.webmanifest`, and rc files such as `.babelrc` that hold
  JSON): the line that opens the root (or each record of a file with one per line), then an
  object root's top-level keys, or an array root's elements, each object element by its first
  key. Nesting depth decides, not indentation, so a key after a block comment
  (`/* c */ "a": 1,`) or after a closing brace (`}, "c": 2,`) is found, and an element opened on
  the line that closes the one before (`}, {`) too. Brackets inside strings and comments do not
  count, and JSON5's bare and single-quoted keys do.
- **Everything else**: every line at indentation zero except blank lines, comments, lines of
  closing punctuation alone (`}`, `});`, `]);`, a trailing comment allowed) and an Allman-style
  `{` line, plus lines indented by up to four spaces that declare something:
  - a `function`/`class`/`def`/`fn`/`fun`-style keyword line, unless the keyword is an object key,
    an import-list member or a property access (`enum: [...]`, `describe,`, `set.add(x)`,
    `it.skip;`); in JavaScript and TypeScript, also a test block reached through a modifier
    (`it.skip('later', () => {`, `it.each` tables) or a chain called with a title **and** a second
    argument, which is the callback a test call passes (`it.custom('titled', () => {`,
    `it.effect('adds', () => …`);
  - a method named first whose parameter list closes into a body, on the same line or a later one
    (`async *entries() {`, `*values() {`, `#secret(): string {`, `async send(` …
    `): Promise<void> {`, or `}: Args): Promise<void> {` after a destructured parameter);
  - a method written return-type-first (`public int getN() {`, `Future<void> load() async {`),
    with its `{` at the end of the line or alone on the next, with its whole body on the line
    (`public int get() { return n; }`, and in Java and C# a constructor's too), or with an
    expression body (`int Twice(int x) => x * 2;`); in Java and C#, also an interface or abstract
    method with no body (`double area();`);
  - an arrow-function member (`handle = (event) => {`);
  - in C++ (`.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx`, `.h` and the like), inside a class body
    (under `class`, `struct`, a nested `union` or an access specifier such as `public:`), every
    member function, constructor, destructor and operator, declared (`void set(int v);`,
    `virtual void draw() = 0;`) or defined (`int get() const { return n_; }`), with qualifier
    macros and `[[attributes]]` allowed — including one whose argument nests, as a conditional
    `noexcept` and a `GUARDED_BY(mu_.lock())` do; elsewhere a function whose body is on its line or
    opens below it, qualified names included (`std::string Foo::name() {`). `int x(5);` and
    `Foo f(1);` outside a class are variables and stay out, and so does `static_assert(…)`. A
    `union` is a type only when a name or the anonymous form's brace follows it, never an argument
    list, so `union(a, b)` and `union(setA, setB);` are calls and stay out. A
    capitalised call with an underscore (`Q_PROPERTY(…)`, `GENERATED_BODY()`, a field's
    `ABSL_GUARDED_BY(mu_)`) or a builtin such as `__attribute__((…))` is a macro, not a member,
    unless a body follows it (`BOOST_AUTO_TEST_CASE(works) {`); `RGB(int r, int g, int b);` is a
    constructor. A class head may carry an export macro, `__declspec(…)` or `alignas(…)`, and
    preprocessor lines and access specifiers inside a class do not end it.

  An annotation or attribute on the declaration's own line does not hide it
  (`@Override public String toString() {`, `@HostListener('click') onClick() {`,
  `[HttpGet] public IActionResult Get() {`) in languages that have them (Java, Kotlin, Scala,
  Groovy, C#, Dart, Swift, TypeScript and JavaScript). A parenthesis inside a quoted default value
  (`paren(s = '(') {`, a C# verbatim string, a C++ `1'000` or `u8'a'`) does not unbalance a
  signature, and neither does a trailing comment (`void set(int v);  // Sets it.`) or a block
  comment before the body (`run() /* entry */ {`). A line deeper than four spaces counts when it
  declares a member of a type the outline lists: a Java inner class's methods, a nested C# class's
  or C++ `class`/`struct`/`union`'s, an `impl` inside a Rust `mod`.

  Lines shaped like these that are not declarations stay out: control flow (`if (`, `else if (`,
  `for (`, `foreach (`, `using (`, `lock (`, `switch (`, `catch (`; in Java and C# also with no
  space, as in `foreach(` and `lock(`, which elsewhere may be method names), `assert x;`,
  `return foo(`, `new Foo(`, `go func() {`, `defer func() {`, a call that closes into a callback
  (`useEffect(() => {`, `).then(() => {`), a chained call (`foo(x).then(`), a call on an object
  named like a keyword (`it.next('resume')`, `impl->value = f(`, Kotlin's `it.split(",")`), and a
  statement followed by another on the same line (`foo(x); if (y) {`). A `describe`/`it`/`test`
  chain counts when it is reached through a test modifier (`it.skip`, `test.extend({})('z', …)`,
  `it.each` tables) or when it is called with a title and a second argument — the comma before the
  callback is what says so, and a title alone (`it.next('resume');`) or a body further along the
  line (`it.next('resume').then(() => {`) is a plain call on a variable named `it`. In `.ts`, `.mts`, `.cts`,
  `.mjs` and `.cjs` files, the text of a multi-line template literal, and of a string continued
  with a trailing backslash, is skipped at any indentation, and a `/` right after a condition's
  `)` (`if (ok) /\d+/.test(s)`) opens a regex. `.tsx`, `.jsx` and `.js` files are not scanned for
  it, because JSX text may hold a `/*` or a lone backtick that would open a comment or template
  that never closes, and a scan that still ends inside one masks nothing. A `#` line is a comment
  in Python, shell, YAML, TOML, Ruby and PowerShell files, Makefiles, Dockerfiles (unless the name
  ends in a code extension, as `makefile.c` does), and extension-less scripts that start with
  `#!`; elsewhere C preprocessor lines and Rust attributes stay in.

- **What it covers:** these shapes fit TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin
  (declarations with `fun`; a `name(args) {` line there is a call taking a trailing lambda), C#
  (members at indentation 8 under a block-scoped `namespace X {`), Dart, C++ class members and
  JSON. The supported shapes are the `Read outline contract` table in `src/tools/file.test.ts`.
  Not covered: Kotlin `companion object` members, a Dart constructor with no body, a signature
  whose closing `)` shares a line with its last parameter, and PowerShell `<# … #>` block
  comments.

What an outline saves depends on the file: `src/agent/loop.ts` goes from 2876 lines to 51, and
this README goes to its 33 headings. A test file keeps its `describe`/`it` lines, and a JSON file
outlines to its top-level keys. Each entry is cut at 512 bytes and ends with `…`, so one minified
line cannot crowd out the rest. The outline is capped at 2000 entries or 50 KB, with a note naming
the line where the rest start, and the header and note fit inside that budget whatever the path's
length. It takes no `offset` or `limit`, and passing either is an error.

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
deletions. Each update hunk starts with a bare `@@` line (line numbers in a unified-diff header are
accepted but not used) and applies in order: its context and removed lines must occur exactly once
in the file, or exactly once at or after the end of the previous hunk, so a function tail such as
`return nil` / `}` that also ends an earlier function is still found when an earlier hunk sits
between the two. Book never picks between several candidates. Reread the affected range and
regenerate the hunk after a `patch_context_not_found` or `ambiguous_patch_context` error. Patches
preserve an existing file's LF/CRLF convention and UTF-8 BOM, validate all files before writing,
verify the post-state, and roll back earlier files if a later commit fails. Binary and
mixed-line-ending updates are rejected rather than guessed.

Mutation reliability guardrails, tuned for heterogeneous models:

- **Read-before-edit is enforced.** `Edit`/`MultiEdit` (and `Write` over an existing file) fail
  with `file_not_observed` until the file has been Read or `@`-mentioned this session, and fail
  with `stale_file_observation` when it changed since last observed.
- **Whitespace-tolerant recovery.** When an exact `oldString` match fails, Book tries two
  deterministic relaxations — trailing-whitespace-insensitive and uniform-indent-shift — and
  applies one only when it matches a single location; the result notes the tolerance used.
  `replaceAll` always requires exact matches.
- **Cross-harness argument aliases.** Claude Code-style spellings (`file_path`, `old_string`,
  `new_string`, `replace_all`, Grep `glob`/`-A`/`-B`/`-C`/`-i`, ApplyPatch `input`) are normalized
  to Book's canonical arguments before validation, and `invalid_arguments` errors list the allowed
  argument names. Grep's `-n` is accepted and ignored, since its results always carry line
  numbers. With ripgrep, Grep accepts ripgrep's regex syntax including inline flags; the portable
  fallback accepts leading `(?i)`, `(?s)` and `(?m)`.
- **Malformed-JSON arguments.** A call whose arguments are not valid JSON fails with
  `invalid_json_arguments`, and the error names the shape the text arrived in rather than reporting
  schema errors about arguments the model did send:
  - _truncated at the start_ — the text does not begin with `{` and is the rest of an object,
    ending in its closing brace, which is usually a provider or a router dropping the call's first
    fragment on the wire. The model's own JSON was fine, so the advice is to resend the whole call
    unchanged.
  - _wrapped_ — a complete object arrived inside a code fence, a tag or a sentence, or text
    followed a complete object. The object is intact, so only the text around it has to go.
  - _not an object_ — there is no object in the text at all, such as a bare `ls -la` or a JSON
    array. Send one object per call.
  - _cut off at the end_ — the arguments stop before the JSON is complete, so the output was
    probably truncated. Resend, and split the change into smaller calls if its arguments are long.
  - _two objects_ — more than one JSON object arrived in one call. Send exactly one per call.
  - _single quotes_ — a key or string value is single-quoted. JSON needs double quotes.
  - _other syntax_ — most often an unescaped backslash or a newline inside a string, including a
    backslash that escapes the closing quote (a Windows path ending in `\`, which reads as a
    cut-off string and is not one).

  Three malformed shapes never reach that refusal at all, because Book repairs them itself:
  a control character written literally inside a string is escaped (the tool receives the same
  character the model sent), a comma directly before a `}` or `]` is dropped, and closing `}`/`]`
  brackets missing at the very end are appended. A repair only runs when the repaired text parses
  _and_ satisfies the tool's own schema; anything else — a dropped opening fragment, a value cut
  off mid-way, a string left open — is refused, never approximated.

  "position N" counts in the raw argument text, which the model sees again verbatim on replay —
  the providers mark a call whose arguments never parsed with a typed field carrying the raw text
  and the parse error, rather than wrapping them in `arguments` — so the text on both sides of the
  position is quoted too, and an invisible character (a NUL, a BOM, an ESC) is shown as a `\uXXXX`
  escape rather than folded to a space, so the one V8 rejected stays visible. Such a call is
  refused right after the call is normalized, before PreToolUse hooks and the permission prompt:
  it can never run, so a hook would judge it unread, and in `default` mode the user would be asked
  to approve a call that cannot — with "Always" saving a permission rule built from nothing.
  Schema-invalid arguments (`invalid_arguments`) and unknown tools (`unknown_tool`) are refused at
  the same point, for the same reason: a Bash call with no `command` has no primary argument, so
  an "Always" there would save a bare `Bash` rule allowing every Bash call. A tool that _is_
  active but whose arguments this run's allowed-tools rules do not cover is refused as
  `arguments_not_allowed` just before the prompt instead — the tool needs no activation, so "call
  ToolSearch" would name one that already has it and cannot lift the rule. Under a
  `Bash(<pattern>)` rule a command that chains, pipes, redirects or substitutes outside quotes
  (``; & | < > ` $ ( ) { }``), uses `$` or a backtick inside double quotes, or has a line break or
  an unterminated quote is refused the same way, and the refusal says to send each command as its
  own Bash call; the whole command must also match the pattern. Quotes are read, so
  `git commit -m "fix(x): y"` and `git stash show 'stash@{0}'` (on Windows only under Git Bash or
  another `bash` or `sh` on the MSYS runtime) pass `Bash(git *)`; a backslash or caret before a
  quote and a typographic quote are refused because a shell may read them differently, and on
  Windows any single quote is refused unless the session shell is a `bash` or POSIX `sh` on the
  MSYS runtime, such as Git Bash, where `'` is read exactly as on Linux (use double quotes under
  PowerShell, cmd.exe and the other Windows shells). A
  bare `Bash` rule admits any command. The
  rule constrains the command's text, not what the program does with its options (`Bash(git *)`
  still admits `git -c core.fsmonitor=… status`), and is not a sandbox: narrow the pattern when
  that matters.

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
so a probe can pass only through memory, never by reading what the teaching session edited.
Teaching and probe run in separate homes: the probe gets only its own memory directory (approved
files and `MEMORY.md`, no dot-entry, no sessions, no other project), and a probe that inspects
processes, the eval sources, transcripts or an old inbox is reported as contaminated and never counted
as a pass. Every item also runs with memory disabled (the baseline) on the same probe. Items cover explicit and
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

`Write` remains appropriate for generated or intentional full-file replacement. What the **model**
reads back differs from what you see: overwriting returns a unified diff, but creating a new file
returns a one-line confirmation — the path, the line count and the byte count — because a diff of
content the model just wrote is a second copy of the whole file in every following request. The diff
is still what the transcript, the session record and the SDK render. `ApplyPatch` gets the same
confirmation when every file in the patch is a creation, one line per file, because GPT/Codex-family
models are steered to it and an add-only patch is nothing but added lines; a patch that also updates
or deletes a file keeps its diffs, whose removed lines are the part the model cannot re-derive. The
`apply_patch` provider alias maps to `ApplyPatch`, and legacy tools are not silently reinterpreted.

What a `PostToolUse` hook writes is what the model reads: a hook that rewrites `toolOutput` replaces
the confirmation too, rather than having its text hidden behind the line the tool wrote in its place.

The reasoning Book replays as text is bounded inside the turn in progress. Between 2 and 5 of a turn's
newest assistant steps go back with their reasoning attached — the step being continued, the one
before it, and room to grow — and the cut that drops the rest moves 4 steps at a time, so a request
extending another does not change the messages the provider has already cached. Steps older than the
cut lose their reasoning exactly as a closed turn's does. This bounds the reasoning Book replays as
text: the OpenAI-compatible routes, and reasoning carried across providers. Anthropic's signed
thinking blocks are replayed from the provider's own `providerMetadata` and are unaffected. The
`/context` breakdown and the compaction estimates count only the reasoning a request actually sends,
so a long single turn is not reported as fuller than it is.

## Tool discovery

`ToolSearch` matches a query by its words — tool names, aliases, intent keywords, and at least two
description words — and falls back to fuzzy matching for a misspelled name. It is callable whenever
deferred discovery exists, including eager mode, where it names the matching tools that are already
active instead of being refused.

When tools are deferred, the system prompt's `Deferred tool catalog` section lists every authorized
deferred tool by name, grouped by category, with a hint of eight words or fewer — about 1,800
characters for the 25 deferred tools of the default registry. MCP tools are listed by name only (a
server writes its own descriptions), and a namespace of more than 12 of them is summarised as a count
with a pointer to the `namespace` filter. The list names a tool whether or
not it is loaded, so loading or evicting one never changes the text; it changes only when
authorization does (the permission mode, an agent role, or a skill or command restriction).

`ToolSearch` with `query: "select:WebFetch,WebSearch"` loads exactly those tools, skipping the
scoring. Names are canonical names or aliases, in any letter case, separated by commas or spaces; two tools that differ only by case need the exact name. Authorization is the same as for
a search: a name that no tool has, or that the role, mode or capability rules exclude, gets a line
naming it, a tool that is already active says so, and the loaded-tool and schema budgets still
apply. `category`, `namespace` and `limit` are ignored with `select:`. Loaded tools are declared to
the provider from the next model turn.

A listed tool can also be called directly, without `ToolSearch`: a call to an authorized deferred
tool that is not active runs just in time. It is active for the rest of that model turn and loaded
for the next one, exactly as `select:` would load it, and it then meets every gate a call after
`select:` meets: the argument-scoped `allowed-tools` rules, its schema, the permission mode, the
`PreToolUse` hooks and the permission prompt. The same holds for a core tool that became available
after the turn's request was built, such as `BashOutput` after a background `Bash` earlier in the
same response, or `Write` after an approved `ExitPlanMode`. Authorization is `select:`'s too, so a
tool outside the agent role, `allowed-tools`, the mode or the run's state is refused as
`tool_not_active`, as before, and its schema is never shown; the refusal says which of those it is,
and plan mode still refuses its mutating tools with its own message.

A `permissions.deny` or `ask` rule on `ToolSearch` itself, or a `PreToolUse` or `PostToolUse` hook
whose matcher names `ToolSearch`, turns direct calls off for the run: whoever wrote it meant to gate
or to audit discovery, so a direct call to a tool that is not active is refused toward `ToolSearch`
as before, where the rule or hook applies, and the deferred-tool list does not offer direct calls. A
hook with no matcher runs on every call, the direct one included, and turns nothing off; nor does an
allow rule.

Before a turn's first model call, Book also routes what you typed: a URL (`http://` or `https://`,
in a code fence too) activates `WebFetch`, and search intent activates `WebSearch`. Search intent is
`search`, `look up`, `latest`, `news`, `tìm` or `tin tức`, as whole words in any letter case, so
`research` and `searching` do not count. The tool is loaded the way `ToolSearch` loads one, under the
same authorization and budgets, so the turn's first request already declares it and the model spends
no turn searching. Only text you typed routes: a command's body, an inlined file, an agent's
completion notice and a subagent's task never do, and nothing routes where direct calls are off.
Routing runs no tool and adds no prompt text, so the system prompt and the deferred-tool list are the
same with it or without it; the request's tools array gains the tool, as after a search.
`toolDiscovery.intentRouting: false` turns it off.

Invalid arguments on a call to a tool the turn's request did not declare (called directly, or loaded
by `select:` earlier in the same response) are refused with the tool's argument names and types, two
object levels deep and at most about 2,000 characters, then a pointer to `select:`; the tool is still
loaded, so the next attempt has its schema. A tool whose schema alone exceeds the schema budget still
runs, with a line saying it was not loaded, and is admitted again on each call; `select:` and a search
that cannot load it say so. Activations are logged under `BOOK_DEBUG` (`tools:discovery`) with their
reason: `search`, `select`, `direct`, `route` for intent routing, or `host` for a tool Book loads
itself (a skill's resource reader).

## Permission rules and modes

`permissions.allow`, `permissions.ask`, and `permissions.deny` are matched against every tool call.
`deny` beats `ask`, and `ask` beats `allow`.

A rule's pattern is a glob with two wildcards: `*` (or `**`, the same) matches any run of
characters except a line break, spaces and `/` included, and `?` matches exactly one character
that is not a line break, `/` included. Every other character matches itself. So `deny: ["Bash(rm /tmp/a?)"]` denies `rm /tmp/ab` but not
`rm /tmp/a` or `rm /tmp/abc`, and `Read(src/a?.ts)` covers `src/ab.ts` but not `src/a.ts`. The same
reading applies to every rule kind: `deny`, `ask` and `allow`, the path rules of `Read`, `Write`,
`Edit` and the other file tools, `allowed-tools` capability rules, and `sandbox.excludedCommands`.
The one exception is an exact Bash `allow` rule, below, which compares as plain text.

**How `allow`, `deny` and `ask` read a Bash command.** The Bash tool runs `command.trim()`, and
`allow` rules are read against that:

- An **exact rule** is a `Bash(<pattern>)` whose pattern has no `*`. It admits a call only when the
  trimmed command is, character for character, the pattern, compared as plain text (so `?` and
  `[` mean themselves: `Bash(ls a?)` admits `ls a?` and not `ls ab`; a `?` alone does not make it
  a glob rule): `Bash(cd x && npm test)` admits `cd x && npm test`, with or without
  surrounding whitespace, and nothing else, not even `cd x && npm test; rm y`. It does so whether or
  not the command is compound, because you wrote that exact line down. "Always allow" on a
  one-line compound command saves exactly this rule.
- A **glob rule** has a `*` (`Bash(git *)`, and `Bash(*)` too). It admits a call only when the whole
  trimmed command matches and the command is a single command. A command that chains, pipes,
  redirects or substitutes outside quotes (``; & | < > ` $ ( ) { }``), uses `$` or a backtick inside
  double quotes, or has a line break or an unterminated quote does not match, so it falls through
  to the prompt: `Bash(git *)` does not admit `git status && rm -rf ~`. Quoted arguments are fine
  (`git commit -m "fix(x): y"`), and whitespace around the command is ignored.
- A bare `Bash` rule (no pattern) admits every Bash command, except a compound one while a Bash
  `deny` or `ask` rule exists (see below).

`deny` and `ask` rules read only the first line of the command (and the first line of the trimmed
command, so leading whitespace does not slide past them), plus the whole trimmed command as one
glob. Book does not parse shell, so a command chained after `&&`, `;` or `|`, or placed on a later
line, is not seen by them: `Bash(rm *)` in `deny` does not match `echo hi && rm x`, nor `echo hi`
followed by a line `rm x`. A Bash `deny` rule is therefore **not** a complete guard on its own.
What makes it safe to rely on is this: while any `deny` or `ask` rule names Bash (a rule on another
tool, such as `Read(.env)`, does not count), a compound command that no rule matched is **always
asked about**, in `auto` as well. Only an exact `allow` rule for that very line, or
`bypassPermissions`, lets it run without the prompt; a bare `Bash` or glob `allow` rule does not.
In `dontAsk` it is refused. The order for Bash is deny, then ask, then exact allow rules, then the
compound prompt, then glob and bare allow rules. A command that only _quotes_ the text
(`git commit -m "rm stuff"`) is not compound and is not prompted for. With no Bash `deny` or
`ask` rule nothing changes.

**Session rules.** "Always allow" also adds the rule it saves to the session's "approve all"
rules, which act as `allow` rules for the rest of the session. Two kinds of call are admitted by
only one session rule, the call's own exact rule (the one "Always allow" saves for that very call):
a compound command under a Bash `deny` or `ask` rule, and any call a `permissions.ask` rule
matches, of any tool. An `ask` rule outranks every `allow` rule, and a session rule is no
stronger: with `ask: ["Bash(git push *)"]`, a `Bash(git *)` rule saved earlier in the session by
widening "Always allow" on `git status` does not let `git push origin main` skip its prompt, and a
`Write(secrets/*)` session rule does not skip an `ask: ["Write(secrets/**)"]`. "Always allow" on
`git push origin main` itself does admit that same command again in the session.

"Always allow" offers only the exact rule, with no widened `*` rungs, for a command that chains or
redirects or contains a quote character or a `?` (a widened rung is a glob rule, where `?` matches
any one character; the exact rule compares as plain text, so its `?` stays a `?`). Two kinds of
command have no rule at all, and the prompt offers only "Run once" and "Skip" for them: a command
that is multi-line after trimming, and any command that contains a `*`, compound or not. A rule
holding that `*` would be a glob rule, which looks like the exact command on the prompt but admits
more: `Bash(rm -rf build/*)` would go on to admit `rm -rf build/ ~/` without asking.

The same holds for every other tool: a rule never carries a `*` or `?` taken from the call's own
text. A `Write`, `Edit`, `Read` or other call whose path (or a `Glob` or `Grep` whose pattern)
holds either has no rule, and the prompt offers only "Allow once" and "Skip": "Always allow" on
`docs/what?.md` would have saved `Write(docs/what?.md)`, which admits `docs/whatX.md`. A `WebFetch`
rule is the URL's origin with `/**` appended, and an origin holding a `*` (the URL parser accepts
one in a host, `http://*.example.com/x`) has no rule either, since `WebFetch(http://*.example.com/**)`
would admit any http host whose URL contains `.example.com/`. A `?` or `*` in the path or query
is not part of the origin, so `https://example.com/a?b=1` still saves `WebFetch(https://example.com/**)`.
The `--scrollback` prompt (`Allow? [y]es/[n]o/[a]lways`) offers `[a]lways`, and accepts `a`, on
the same terms.

**Windows and `'`.** `'` is a quote in Git Bash and PowerShell but not in cmd.exe. Under Git Bash
`'` is read exactly as on Linux: `git stash show 'stash@{0}'` and `echo';id'` are each one command.
That holds because the Bash tool hands Git Bash the command in the `BOOK_BASH_COMMAND` environment
variable, unset before the command runs, rather than on the Windows command line, so the MSYS
runtime cannot glob it, expand an `@file` in it or strip its quotes. The command runs through
`eval`, so a syntax error reads `bash: eval: line N:` rather than `bash: -c: line N:`, and
`BASH_EXECUTION_STRING` holds the fixed script that evaluates it rather than the command itself.
WSL's `bash.exe` (in a Windows system directory or the `Microsoft\WindowsApps` alias directory),
PowerShell, cmd.exe and any shell that is not on the MSYS runtime (below) still treat every `'` as
making the command compound; use double quotes under those shells.

Every `bash.exe` outside those WSL directories gets the `BOOK_BASH_COMMAND` delivery, but `'` reads
as on Linux only under one on the MSYS runtime: Git for Windows' `bin\bash.exe` and
`usr\bin\bash.exe`, and MSYS2's `usr\bin\bash.exe`. Under Cygwin's `bash.exe`, a shim such as
scoop's `shims\bash.exe`, or a copy with no `msys-2.0.dll` beside it, `'` makes a command compound,
as under the `sh` shells below.

Every POSIX `sh` on Windows gets the same `BOOK_BASH_COMMAND` delivery: `shell` set to an
executable named `sh`, `dash`, `ash`, `ksh`, `mksh` or `zsh` (with or without `.exe`, and with or
without a version such as `zsh-5.9.exe`), whatever runtime it is built on and wherever it lives;
only WSL's `bash.exe` keeps the command line. That covers Git's and MSYS2's `sh.exe` and
`dash.exe`, a Cygwin `sh.exe`, a shim, hardlink, copy or app execution alias of any of them (such as
scoop's `shims\sh.exe`), and busybox-w32 copied as `sh.exe`. Book chooses the delivery by name
alone, so a runtime it cannot recognise still gets the command intact rather than on a command line
it could rebuild, and a program that cannot read the variable fails instead of running anything. Non-POSIX shells such as `fish.exe` or `nu.exe`, and `busybox.exe` under its
own name, keep the command on the command line, because the script that reads the variable is
POSIX sh; that is a known gap rather than a safe choice, so prefer a POSIX shell.

Under an `sh` on the MSYS runtime `'` is read exactly as under Git Bash. Book detects the runtime
when it resolves the shell, for a `bash` and an `sh` alike and however the shell was chosen, by
`msys-2.0.dll` beside the executable, or in `..\usr\bin` for Git's `bin\bash.exe` and `bin\sh.exe`
launchers. Under every other `bash` or `sh` (Cygwin, a shim or copy with no `msys-2.0.dll` beside
it, busybox-w32) `'` still makes a command compound: the command is delivered to those shells the
same way, but Windows CI proves only the MSYS runtime's delivery.

Book only calls a `bash` "Git Bash" when it found it on the MSYS runtime. Any other `bash` is named
as a bash whose runtime was not detected as Git Bash. Under every Windows shell that refuses `'`,
the system prompt and `book doctor` carry a hint to use double quotes, and a refusal of a command
whose only problem is a `'`, under an `allowed-tools` rule, names the single-quote rule instead of only asking for the
command to be split. On Windows, with a `bash` or `sh`, `book doctor` prints `msys: yes` or `msys: no` under `Shell:`, the flag that
decides whether `'` is read as on Linux.

Permission _modes_ decide whether you are prompted; they never relax a `deny` rule. A rule in
`permissions.deny` blocks the matching call in every mode, including `auto` and
`bypassPermissions`, and it is evaluated before the prompt, so a denied call never reaches one.
Modes differ only in what happens to calls that no `deny` rule matched:

| Mode                | Unmatched calls                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`           | Checked against `allow`/`ask`, then prompted — except workspace reads, which run unless a rule covers them                                   |
| `acceptEdits`       | As `default`, and file mutations are approved without a prompt too                                                                           |
| `plan`              | Read-only tools only; mutations are refused until you approve a plan                                                                         |
| `auto`              | Run without a prompt, except a call an `ask` rule covers, and any compound Bash command while a Bash `deny` or `ask` rule exists (see above) |
| `dontAsk`           | Refused except for the tools below that never prompt — the mode never prompts, and a user `allow` rule does not exempt a call                |
| `bypassPermissions` | Run without a prompt                                                                                                                         |

Some tools never prompt. `TodoWrite` (the agent's checklist) and `Advisor` (offered
only once you choose a model with `/advisor`; it sends the conversation to that model) are always
allowed,
and `ToolSearch`, `EnterPlanMode` and the managed-agent lifecycle tools (every `Agent*` tool except
`AgentApply`) never reach a prompt; `dontAsk` does not refuse any of them. A `permissions.deny` rule
still blocks them in every mode. A `permissions.ask` rule that names one prompts in `default`,
`acceptEdits` and `auto`, refuses the call in `dontAsk`, and, as for every tool, is not consulted in
`bypassPermissions`. An `ask` rule prompts in `auto` for every tool: `auto` skips the prompt only for
a call no `ask` rule covers, and a run that cannot show a prompt (print mode, the SDK) refuses such
a call. (Bash also prompts in `auto` for every compound command while any Bash `deny` or `ask` rule
exists, whether or not a rule matched it.)

**Memory writes.** `Write`, `Edit`, `MultiEdit` and `ApplyPatch` may write `*.md` files in the
project's memory directory without a prompt, in `default`, `acceptEdits`, `auto` and `dontAsk`. A
`deny` or `ask` rule you wrote still wins, and plan mode still blocks every mutating tool. Only the
main agent gets this, and only with `memory.enabled` and `memory.autoSave` on: a subagent or managed
child cannot write there, and with `autoSave` off memory is read-only. The path must be absolute,
end in `.md`, and sit under no dot-directory (`.git/`, an old `.inbox/`) and no symlink. An `ApplyPatch`
that also names a file outside the memory directory goes through the normal prompt. Each successful
write announces itself (`memory saved: <file>`, or `memory deleted: <file>` for an `ApplyPatch`
delete; an edit of `MEMORY.md` alone says nothing), and the tool row names the file relative to the
memory directory (`memory/<file>.md`). The model deletes a memory with `rm`. A `Bash` command that
is exactly one plain `rm` of memory files needs no prompt in `default`, `acceptEdits`, `auto` and
`dontAsk`, after your `deny`, `ask` and `allow` rules like a memory write: the word `rm`, then one
or more operands, each an absolute path under the memory directory ending in `.md` (not
`MEMORY.md`, not a dot-file) and made of letters, digits and `_ . / @ % + = : , -` only. There is no
flag, `--`, glob, quote, `~`, variable, `.` or `..` segment, chaining (`;`, `&&`, `|`), redirect,
substitution or line break, and a path that reaches the directory through a symlinked subdirectory
is not under it; any such command goes through the ordinary `Bash` permission. A session another
agent drives (`learnings`) keeps the prompt for every `rm`, because `Bash` has no memory guard:
that path, like `echo >`, is not checked against file ownership. Every write through a file tool
passes a guard before it lands:

- Text that looks like a secret is refused (`memory_secret_rejected`).
- In a session another agent drives, a topic file needs a `metadata.type` of `project` or
  `reference` (`memory_type_not_allowed`), and only files marked `driver: agent` may be changed or
  deleted, and index lines for any other file kept (`memory_owned_by_person`).
- A topic file with frontmatter is stamped with `metadata.originSessionId` (kept if present),
  `metadata.modified`, and, in a session another agent drives, `metadata.driver: agent`. The rest of
  the file is left byte-for-byte as written.
- Warnings, which never refuse: a topic file over 4,096 bytes, a `MEMORY.md` over 200 lines or 25,000
  bytes, and an index entry whose file does not exist.

`MEMORY.md` counts as read once it loads whole, so the first `Edit` of it needs no `Read`; a cut
index must be read first.

**Workspace reads.** In `default` and `acceptEdits`, a `Read`, `Glob` or `Grep` that the tool can
serve runs without a prompt: a target inside the workspace, or inside Book's memory directory (for
`Glob` and `Grep`, an absolute `path` or pattern into it; neither lists a dot-entry such as
`.format`, and every agent that has the memory loaded can search it, a subagent included). The target is resolved the way the tool resolves it: `..` is applied
and symlinks and junctions are followed, so a link inside the workspace that points out of it still
asks. A `Grep` with no `path` searches the workspace, and so does a relative `Glob` pattern: a
`pattern` is anchored to the workspace the same way a relative `Read` path is, and an absolute
pattern names its own root. A `Glob` that would start walking outside the roots
(`../**`, `.{.,x}/*`, an absolute path elsewhere) still asks. Other read-only tools (`GitStatus`, `GitDiff`, `WebFetch`, …) still ask.
On Windows, `Glob` and `Grep` do not search a workspace on a network (UNC) path such as
`\\host\share` (they answer `path_unreadable`). In a local workspace their walks do not follow a
link to one, and a `Grep` `path` that reaches one through a link is refused before it is resolved.
A directory you configured there, an `additionalDirectories` entry or the memory directory, is
searched as `Read` serves it, except for a link inside it to another network location. `Grep`'s
ripgrep backend takes its ignore rules from the root `.gitignore` alone, as the portable backend
does: nested `.gitignore`, `.ignore` and `.rgignore` files, a parent directory's,
`.git/info/exclude` and your global excludes file do not narrow a search there.

What still asks:

- A call an `ask` rule covers, and a call a `deny` rule blocks.
- Any `Grep` or `Glob` while you have a `deny` or `ask` rule for `Read`, `Grep` or `Glob`. A `Read`
  rule cannot see what they read (`Grep` with `path: ".env"` returns every line of it), so they
  fall back to the prompt.
- Book's project-local settings, `.book/settings.local.json`, and the `.book` directory that holds
  it, since that file can carry an API key. `Grep` never searches that file at all, whatever path
  or link leads to it.
- Everything, in a workspace that holds a home directory, yours or Book's own (`BOOK_HOME`),
  also when either is reached through a link: a session started in your home directory. A home
  holds SSH and provider keys and the trust store.
- Any read whose resolved path lands inside a home directory **held by the root that serves it**. The
  root that serves it is the one the path resolved against, the workspace first. An approved
  `additionalDirectories` entry that contains a home directory still prompts for every file under
  that home, and approving a parent directory does not re-guard the workspace inside it: with the
  workspace at `/home/u/proj` and `/home/u` approved, a plain `Read package.json` runs without a
  prompt. A root that merely sits _below_ a home — which is nearly every workspace — is not guarded
  by it; the bullet above already covers that case by asking for everything.
- Any `Grep` or `Glob` whose **scope** reaches a guarded home. These two name a subtree rather than
  a file, so a scope is judged on containment rather than on its own path: `Grep {path: "/home"}`
  asks, because the scope holds a home it would otherwise print lines from. A scope that is merely
  below a home, and holds none, is an ordinary read.

**Plan mode.** `plan` judges reads the way `default` does. A guarded read — a target inside a home
directory the serving root holds, a search whose scope reaches one, a call an `ask` rule covers —
prompts exactly as it does outside plan mode, and a target outside every root is refused there too.
An unguarded workspace read still runs without a prompt, which is what a plan is written with.

**Git.** `GitStatus`, `GitDiff`, `GitLog` and `GitBranch` are the read-only Git tools, and they run
without a prompt in `default` and `acceptEdits`. Because a repository's `.git/config` is a file the
clone brings with it, all four pass `-c core.fsmonitor=false`, `-c core.pager=cat`, an empty
`-c core.hooksPath`, `-c core.untrackedCache=false`, `-c gc.auto=0`, `-c log.showSignature=false`
and `--no-optional-locks`, with `GitDiff` adding `--no-ext-diff --no-textconv` and `GitLog` adding
`--no-show-signature`, and `GIT_PAGER=cat` / `GIT_TERMINAL_PROMPT=0` in the environment. The
signature switches matter because `log.showSignature` makes `git log` verify every signature it
prints, and verification runs `gpg.program` — a program the repository names. The branch and
status in each turn's `<session-state>` git line are read the same way, since that runs before any
tool call. Among the tools, the hardening covers
**these four only**: `GitCommit` runs with your own `argv` and environment, as before (plus the
dotfiles home ceiling below),
so your `pre-commit` and `commit-msg` hooks still run. A repository can still configure clean and
smudge filters, and those run on `status` and `diff`; Book does not suppress them, because that
would mean rewriting the command you asked for.

`GitStatus` and `GitDiff` pass `--ignore-submodules=dirty`, as do `/diff`, `/review` and agent
isolation, so changes inside a submodule are not listed, while a submodule whose recorded commit
moved still shows; run `git -C <submodule> status` for the rest. None of these reads fetch: they run
with `GIT_NO_LAZY_FETCH=1` (read by git 2.44 or later, and older releases patched in 2024) and an
empty `GIT_ALLOW_PROTOCOL`, so in a partial clone that is missing an object the read fails with a
note on fetching it yourself. The prompt's git line and the TUI status line read the status the
same way, and in a partial clone (`extensions.partialClone`, a `remote.<name>.promisor`, or a
`remote.<name>.partialCloneFilter`) they show the branch only and skip the status. `/diff` shows what `GitDiff` does, with the same flags. A
`git` command you run through `Bash` is unchanged.

**A dotfiles home.** When your home directory itself holds a `.git` (a dotfiles repository), that
repository is not the repository of a project below your home that has no `.git` of its own. Book's
own git (the four tools above, `GitCommit`, the `<session-state>` git line, `/review`, the TUI
status bar and managed-agent isolation) runs with your home directory as a `GIT_CEILING_DIRECTORIES`
entry, appended to one you exported, so in such a project `GitStatus` and `GitCommit` report that
it is not a git repository, the status bar shows no branch, the prompt carries no git line,
`/review` refuses as it does outside a repository, and patchers and validators refuse. A project
with its own `.git` is unaffected, and so is a workspace that is your home directory itself: git
never stops at the directory it starts in, so all of them see the home repository there. With no
`.git` in your home directory nothing is added, and a repository above your home is found as
before. `Bash` keeps your own environment, so `git status` run through `Bash` in such a project
still reports the home repository.

**Outside every root.** A `Read`, `Glob` or `Grep` whose target is in the workspace, in a read-only
root, or in an approved `additionalDirectories` entry is served as above. One that is not is
_refused_, not prompted for: no permission rule and no permission mode makes the file tools serve
it, so a prompt would be a question nothing could answer, and an "Always allow" would have saved a
rule for a call that could never run. The result is `blocked` with the code `path_outside_workspace`
and a message naming the path, the directories already honored, and the two ways through — add the
directory to `additionalDirectories` (a project-declared one also needs `book trust dir <path>`), or
start Book somewhere that contains it. This is the same in `default`, `accept-edits` and `plan` —
and in `dontAsk`, which refused these anyway. What changed there is the kind of refusal: it used to
be `permission_denied`, whose remedy says to add an allow rule, and no rule or mode can make `Read`
serve a path outside every root. `dontAsk` still refuses a _workspace_ read with no allow rule, as
before; only an outside target now gets the refusal that names the directory that would serve it.

A `permissions.ask` rule that names such a target is still asked, in `default` and `auto` alike
(`ask: ["Read(**/.env)"]` and a `Read` of `/etc/app/.env`): the rule outranks the early refusal,
and allowing the call only lets the tool refuse it itself. With nobody to answer, the refusal names
the unreachable target in both modes, never the ask rule, which could not help.

**Writes in an approved directory.** An approved `additionalDirectories` entry is a root for the
write tools too: `Write`, `Edit`, `MultiEdit`, `ApplyPatch` and `NotebookEdit` accept an absolute
path inside one, and the write is judged, guarded and observed exactly as the same write in the
workspace is — `default` prompts, `acceptEdits` approves it, a `deny` rule blocks it in every mode.
The entry carries the workspace's protections too: its own `.book/settings.local.json` and the
`.book` directory holding it are guarded, a file must be read before it can be edited, and a write
into a home directory held inside the entry still asks. A _relative_ path stays anchored to the
workspace, so a bare `./notes.txt` is never re-anchored to a directory you did not name. Without an
approved entry, the same absolute path is still `path_outside_workspace`.

A path rule for `Read`, `Write`, `Edit`, `MultiEdit` or `NotebookEdit` is also matched against the
other spellings of the target — relative to the workspace and absolute, before and after following
links — in every mode. So `deny: ["Read(.env)"]` also stops a `Read` of
`/abs/path/to/workspace/.env` or `src/../.env`, and `deny: ["Write(.env)"]` holds under `auto` and
`bypassPermissions` whatever the call writes it as, `ApplyPatch` included. `ApplyPatch` matches its
targets' spellings the same way, and `deny` and `ask` fold case as they do for a single-path tool.

A path inside an approved `additionalDirectories` entry is offered the same root-relative spelling
to `deny` and `ask` — `deny: ["Write(.env)"]` stops `/srv/app/.env` as well as the workspace's own
— and **not** to `allow`. That asymmetry is deliberate: `deny` and `ask` restrict, so a wider set of
spellings can only narrow what a call may do, while `allow` widens and must not acquire a new
meaning. A workspace-shaped `allow: ["Edit(src/**)"]` therefore does **not** cover
`/srv/app/src/…`; to allow a write in an approved directory, write the rule with its absolute
path.

**When nobody can answer a prompt.** Print mode, the SDK, and a background agent with no
interactive approver cannot show a prompt, so a call that would prompt is refused. The model is told
that nothing in the run could approve it, not that a policy blocked it, and what would let the call
through:

| The call                                         | What lets it through                                                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Most calls                                       | A `permissions.allow` rule for it, or `--permission-mode auto`                                                                                                                                              |
| One with no rule of its own                      | `auto`, or what the remedy names for the reason: a multi-line Bash command sent as one-line calls, a Bash command naming its files instead of `*`, or an allow rule you write for another tool's `*` or `?` |
| One an `ask` rule covers                         | Narrowing or removing that rule (it outranks allow), or `bypassPermissions`; `auto` still asks                                                                                                              |
| A skill that asks for consent                    | A `permissions.allow` rule; `auto` still asks                                                                                                                                                               |
| A compound Bash command under a Bash deny or ask | Sending each command as its own call, the exact rule `Bash(<whole command>)` in `permissions.allow`, or `bypassPermissions` (if an ask rule matches it, narrow that rule instead); `auto` still asks        |
| A persistent background shell                    | Only `--permission-mode bypassPermissions`                                                                                                                                                                  |
| A `Read`, `Glob` or `Grep` outside the workspace | Nothing: the tool cannot open it (under an `ask` rule too, in `auto` as in `default`)                                                                                                                       |

In print mode and the SDK, the first such refusal of each tool in a session also prints the remedy
for the operator (on stderr in `text` output, as a `notice` event in `stream-json`); a call nothing
can help prints none. That covers the main agent's own calls: a managed agent's refusal goes to its
own model, which reports it back. A refusal by a `deny` rule names that rule, a refusal in `dontAsk`
says so, and a prompt withdrawn before anyone answered it (an interrupt, a session change, a
stopped agent) is reported as dismissed rather than declined.

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
runtime — hooks are capped at 10 s each (a hook still running then is killed outright, together
with the processes it started; a process the hook leaves running in the background after it exits is
neither waited for nor ended) and run sequentially in declaration order. Only `UserPromptSubmit`,
`PreToolUse`, and `PreCompact` can refuse the operation outright.

Off Windows each hook runs in its own session and process group, as foreground `Bash` commands
do, so a timeout can end all of it. A hook therefore has no controlling terminal: it cannot
prompt through `/dev/tty`, and a Ctrl+C in the terminal goes to Book, not to the hook.

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
book trust dir ./shared                # and for a project-declared additionalDirectories entry
book trust dir --all-pending           # every such directory still awaiting a decision
book trust dir ./shared --reject       # refuse it
book trust provider evil               # a provider (origin and key) only the repository declares
book trust provider --all-pending      # every provider still awaiting a decision
book trust provider evil --reject      # refuse it
```

All of them take `--workspace <path>`; `book doctor` prints it for you when it is diagnosing a
directory other than the one you are in. Each invocation records one decision and leaves every
other decision — in this workspace and in every other — untouched.

`book trust provider` decides where a repository's provider sends requests and which key it
carries; what it covers, and what a repository can no longer change on a provider you define, is in
[Providers a repository declares](configuration.md#providers-a-repository-declares).

`book trust dir` shows the real path beside the declared text before recording anything, because
the decision is keyed by where the path _really_ goes: a repository could declare `./shared` for a
symlink pointing at your home directory, and approving the string you were shown would approve a
path you never saw. Retargeting the link makes the entry pending again, and `--reject` records the
refusal under that same real path.

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

## The environment a command gets

A command starts from Book's own environment, and a `Bash` call's `env` is layered over it. One
value is deliberately kept back: Book defaults `NODE_ENV=production` in its own process so the TUI
loads React's production renderer instead of the 2-3x slower development build, and a default
Book invented for itself is not the command's business. `npm install` in a project silently drops
devDependencies under it, and a test runner reads a production build flag nobody asked for.

So a `NODE_ENV` that Book defaulted itself never reaches a command, on any path that starts one —
`Bash` foreground and background, hooks, MCP stdio servers, a `Check` command, slash-command
expansion, clipboard and git helpers, and Book's own detached job runner and supervisor, which is
the one a persistent job's command would otherwise inherit through. A `NODE_ENV` you exported
before starting Book always passes through, and so does one set explicitly — in `ToolContext.env`,
a hook's own `env`, or an MCP server's `env`. **Explicit wins, even when it agrees**: a hook or a
server configured with `NODE_ENV=production` gets `production`, because that is the one value where
a request and Book's own default look identical, and a setting somebody wrote down is not deleted
by looking like something else. What is stripped instead is the environment `ToolContext.env` _is_
— Book's own, marker and all — since a copy of `process.env` is not a request for the default it
carries.

### Provider keys are redacted from tool output

A command can print Book's own credentials: `$BOOK_API_KEY`, or a settings file such as
`$BOOK_HOME/settings.json` that a test's assertion diff dumps. Every tool result is therefore
redacted once, when it is finalized and before anything is derived from it: each configured
provider secret is replaced by the fixed marker `[redacted: provider key]`. That one step covers
what the model sees, the saved session, the `tool-output` file a clipped result spills into, the
failure head/tail preview, and the `stream-json` `tool_result` event. It applies to every tool
(`Bash`, `BashOutput`, `Read`, `Check`, MCP tools, subagent results), and to the content, the
details, the error message and any string in the result's structured data. The output tail the
interactive UI hands the model when a background shell finishes is redacted the same way.

The secrets are `BOOK_API_KEY`, the session's own key, and the resolved `apiKey` of each configured
provider (a literal, an `{env:VAR}` or a `{file:path}` reference). A provider that only the
repository declares, and that you have not approved, is skipped, so a repository cannot use its
`.book/settings.json` to erase a word from your output. A value shorter than 8 characters is never
treated as a secret, so ordinary output is not mangled. Neither is a well-known placeholder key that
keyless local endpoints ask for (`not-needed`, `lm-studio`, `sk-no-key-required`,
`no-key-required`, `no-api-key`, `dummy-key`, `placeholder`, compared case-insensitively): they are
ordinary words, and erasing them would mangle code and break `Edit` matches. Matching is by exact
value: no pattern is guessed from the key.

A window onto output never cuts a key in half, because neither half would match. A `BashOutput`
chunk stops before a key the limit would split, or runs past it when the key opens the chunk. A tail
(the completion message of a background shell, the 64 KB tail of a command moved to the background)
and the 5 MB background buffer start at a key they would otherwise cut into, so the whole key is
there to be replaced.

A key can also be half written when a running job is read. When a provider key is configured and
the job is still running, a `BashOutput` read therefore stops after the last line break, and the unterminated last line waits until it ends
or the job does; a line with no break at all is returned in pieces of at most 1024 characters, so a
prompt is not held forever. This rule looks only at line breaks and length, never at the key's
value: a rule that held back text resembling the start of a key would let a command guess the key
character by character from which reads come back empty. A finished job returns everything. A
`BashOutput` result also leaves the job's whole buffer out of the record it stores in the session.

This only redacts. The environment a command gets is unchanged: `Bash` children still inherit
`BOOK_HOME` and `BOOK_API_KEY`, so a nested `book` run keeps working.

Limits:

- A transformed key is not caught: base64, hex, or a key a program splits into separate writes with
  a read in between.
- The log file of a persistent background job on disk stays unredacted; only what `BashOutput`
  returns is.
- A key that log rotation splits across files is not caught.
- `PostToolUse` hooks receive the raw output. They run with your environment and can read the key
  directly, so redacting their input would protect nothing.
- Output is redacted when the result is finalized, not while the command runs, so the live output of
  a running command is not redacted.

#### Writing the marker back

The model only ever sees the marker where a key is, so reading a file that holds a key and writing
the whole file back with `Write` would replace the real credential with the marker. `Write`, `Edit`
and `MultiEdit` therefore refuse, with the error code `redacted_secret_overwrite` and the file left
unchanged, when the file on disk holds a configured provider key **and** the new content (or an
`Edit`'s `new_string`) contains the marker. The remedy is an `Edit` on only the lines that need to
change, leaving out the line that shows the marker, or asking you to make the change.

`ApplyPatch` and `NotebookEdit` close the same gap with the same error code. `ApplyPatch` refuses
the whole patch, writing nothing, when an operation **deletes** a file that holds a key (Book can
never write the real value back, so a delete followed by an add loses it), or when an `Update File`
operation adds the marker to a file that holds a key. `NotebookEdit` refuses a `replace` or
`insert` whose `new_source` carries the marker when the notebook holds a key, and a `delete` of a
cell that holds one. When you want such a file or cell deleted, delete it yourself.

`Bash` refuses any command whose text contains the marker, searches and quotes included, whenever a
provider key is configured. The error code is `redacted_secret_command`, and it applies in the
foreground and in the background alike: the marker stands for a key the model cannot see, so a
command has no business writing or using it. To search for the marker text itself, leave out the
brackets.

A marker written to some other file could still be moved over the key file afterwards by a command
that never names it (`mv tmp.json key.json`). So while a provider key is configured, no write may
**add** the marker to any file: `Write` (to a new or an existing file), `Edit`, `MultiEdit`,
`ApplyPatch` (`Add File` and `Update File`) and `NotebookEdit` refuse, with the error code
`redacted_secret_write` and nothing written, when the file's new content holds more occurrences of
the marker than its old content (none, for a new file). Whole files are compared, so an edit that
keeps or removes a quote the file already has still works. The remedy is a placeholder of the
model's own, such as `<your-api-key>`, or asking you to write the text. This includes a repository
that documents the marker, Book's own among them: while a key is configured the model cannot add new
quotes of it. With no key configured nothing is refused. Gaps this does not close: an MCP tool that
writes files, and a `Bash` command that assembles the marker from pieces. The rule counts
occurrences per file, so a write that keeps a file's count the same is not refused, for example
rewriting a file that already quotes the marker into a key-shaped file. And the guard protects
against the model writing the marker back by mistake, not against a deliberate delete: `rm`, or an
`mv` of another file over a key file, still loses the key.

## Shell command timeouts

A foreground `Bash` command is given **300000 ms** (five minutes) by default. The model can raise
that per call with the `timeout` argument, up to **600000 ms** — reach for it before a full build
or test suite rather than after the deadline. It is validated like any other argument, so a value
outside the declared range is rejected rather than quietly ignored. Background commands ignore
`timeout` entirely and take `max_runtime_ms` instead.

When a foreground command is still running at its deadline it is **not killed**. It moves to a
session background shell, and the result reports it as a success that names the `shell_id` and the
output it produced so far, so the next call is a `BashOutput` rather than a re-run of whatever
took five minutes. Read it with `BashOutput` (see below) and stop it with `KillShell`. A command
the host cannot hand over — no shell manager for the context, a session already ending, a process
that exited as the deadline arrived, or a command run by a **subagent or a managed agent** — is
ended as before and reports itself as killed, returning whatever it printed before the kill: the
two outcomes call for different next moves, so the failure message names the deadline it hit and
the ways past it. Subagents and managed agents are refused on purpose: each owns a runtime that is
disposed when its own run ends, and a background shell adopted there would be destroyed at the end
of the very run that reported it as still running.

`BOOK_TOOL_TIMEOUT_MS` overrides the default for every tool, `Bash` included, and where it is set it
is also the **ceiling** on what a single call may ask for: lowering it to 30000 caps a model that
asks for ten minutes, and a request above the limit in force is refused rather than quietly shrunk.
Raising it above 600000 raises the _default_ — which needs no argument to reach — but not the
per-call reach, since the schema publishes and validates 600000 as the maximum. Precedence is the
call's `timeout` (bounded by that ceiling), then a deliberate per-tool setting such as
`agents.checkTimeoutMs` or `agents.taskTimeoutMs`, then `BOOK_TOOL_TIMEOUT_MS`, then the tool's
default. No source can resolve past 2147483647 ms (~24 days), the largest delay a timer can hold;
beyond it Node silently fires after 1 ms.

The same resolution governs every tool that enforces a deadline of its own — `Bash`, `BashOutput`,
`Check`, `Task`, `AgentWait`, and `WebFetch`. Each declares its budget so the host's backstop
outlasts it; when the two are equal the backstop fires first and replaces the tool's report,
including its output, with a bare timeout. The backstop ranks a per-tool setting above
`BOOK_TOOL_TIMEOUT_MS` exactly as the tool does, so a lower blanket override cannot fire it ahead
of `Check` or `Task`. A `timeout` argument sets the host budget only for a tool that publishes
one, so a stray value cannot pull the backstop underneath a tool that times itself.

A command that had to be killed reports itself as killed rather than failed, and returns whatever
it printed on stdout and stderr before the kill, so the failure names the deadline it hit and the
ways past it.

## Waiting for a background shell

`BashOutput` reads a shell's new output and its status. Left to itself it returns at once, which
turns a slow command into one tool call per turn: the model polls, the poll is the whole turn, and
a test suite that takes four minutes costs eight calls that each learn "still running".

`wait_ms` makes the call wait instead. The wait ends when the shell reaches a terminal status —
exited, failed, or stopped — or when the requested time elapses, whichever comes first, and the
result then reports the status either way. It does **not** return early on new output: a chatty
command would then return at once and the wait would be worth nothing, so a noisy test runner costs
the same wait as a silent one. Omit `wait_ms` to read the current output and status immediately, as
before.

The wait is bounded by the same ceiling as every other deadline in force (`toolTimeoutCeilingMs`:
`BOOK_TOOL_TIMEOUT_MS` where set, 600000 ms otherwise), and a `wait_ms` above it is **refused**
rather than quietly shortened, exactly as `Bash` refuses an over-limit `timeout`. It ends early if
the turn is cancelled, and it kills nothing when it does: the shell keeps running, the result
reports the output there is, and a later call can wait on it again. A shell that is still running
and has printed nothing new says so, and what it says next depends on the call: a read is pointed
at `wait_ms` instead of another poll, and a wait that ran out reports how long it waited, so the
model is not told to pass the argument it just passed.

Session shells and `lifetime: "persistent"` jobs are both supported. A shell's terminal
transition is always an event from the manager, so the wait subscribes; a persistent job lives in
another process, so the manager's monitor reads its record file a few times a second and the wait
ends on the transition that read reports.

## What ends a background shell

A **session** shell — the default, and what a foreground command that reached its deadline becomes
— ends with Book. On exit, or when the session is cleared or replaced, Book ends the whole process
tree the command started, not just the wrapper it was handed: the process group on macOS and Linux,
and `taskkill /T /F` on Windows. This is the same escalation `KillShell` uses, and the wrapper is
not killed first on either platform, because the teardown has to walk from a root that is still
alive.

What that covers, honestly, differs by platform. On macOS and Linux the signal goes to the process
group, and a process group outlives the shell that led it — so `npm run dev &` started through a
Git Bash wrapper is ended with Book. On Windows `taskkill /T` walks the tree from that live root, so
a command whose wrapper has **already exited** leaves descendants that nothing here can reach: run
`npm run dev &` inside a Git Bash window, close the window, and Book has no wrapper left to walk
from, and the dev server keeps running. Stop those yourself, or use a session shell that stays in
the foreground. A process that re-parents itself out of the tree — `setsid`, a Windows service, a
daemon that double-forks — is not covered on either platform.

A job started with `lifetime: "persistent"` is deliberately exempt: it is meant to outlive Book, so
it is not ended by any of this. It is stopped through its runner's control file, and
`book doctor` reports the ones that are still running.

**A failure keeps both ends of its output; a success keeps the head.** Any tool result over 50 KB
is clipped, and a notice names the file in Book's user-local `tool-output` directory that holds it
in full, so a `Read` in the same run can open it. What survives the clip depends on the status. A
failed result — a non-zero exit, a refused plan, anything but success — keeps its first few KB
**and** its last, with the count of what sits between them in the notice, because a failed run
puts something worth reading at each end: the `act()` warnings at the top, and the
`Tests 2 failed | 10 passed` every runner prints last. The head is also what carries a failure's
framing, such as the Task tool's `Partial result (the child was stopped; nothing below is
final):`, which is what says the output after it is not finished. A successful result keeps the
**head** alone, where the first thing the command did is.

## Bash sandbox

`sandbox.enabled` runs `Bash` commands inside a sandbox backend: [bubblewrap](https://github.com/containers/bubblewrap) on Linux, which must be installed, and `sandbox-exec` (Seatbelt) on macOS, which ships with the system at `/usr/bin/sandbox-exec`. There is no backend on Windows. When the backend is missing, `sandbox.failIfUnavailable` decides whether the command fails or runs unsandboxed; `book doctor` names the backend in its `Sandbox` section. `sandbox.excludedCommands` skips the sandbox for matching commands, and sandboxed output is prefixed with `[sandboxed]`.

Under bubblewrap the sandbox gives the command fresh PID/IPC/UTS namespaces, a private `/tmp`, read-only system directories, all capabilities dropped, and a lifetime tied to the spawning process. The macOS backend enforces the same policy with a Seatbelt profile; see [macOS (Seatbelt)](#macos-seatbelt) for how it maps and where it differs. Commands are spawned as a direct argument vector — never as a shell string — so the command text is parsed only by the shell running _inside_ the sandbox. Ordinary shell syntax (pipes, `&&`, redirection, substitution) works normally there.

**The workspace root is the only directory bound writable by default**, and it is bound regardless of the `workdir` argument. A sandboxed `Bash` call whose `workdir` falls outside the workspace is rejected rather than granted a wider mount; use `sandbox.filesystem.allowWrite` to add directories deliberately.

### Workspace control files are read-only

The writable workspace bind deliberately stops at the control files your machine acts on _after_ the command exits. Each of these is a way to change what the host does next, not a scratch file:

| Path                                    | How it is protected                                |
| --------------------------------------- | -------------------------------------------------- |
| `<workspace>/.book/`                    | read-only bind, or a read-only mask                |
| `<workspace>/.book/settings.local.json` | read-only mask over `/dev/null`                    |
| `<workspace>/.bookrc.json`              | read-only bind when the file exists                |
| every workspace git directory           | read-only bind by default (issue 373)              |
| a git dir's `hooks/`                    | as above (or read-only mask when `allowGitWrites`) |
| a git dir's `config`, `config.worktree` | as above (or read-only bind when `allowGitWrites`) |
| a git dir's `commondir`, `gitdir`       | as above (or read-only bind when `allowGitWrites`) |
| a `.git` pointer file                   | read-only bind                                     |
| a `core.hooksPath` inside the workspace | read-only bind, or read-only mask                  |

Without this, a sandboxed command could write `.book/settings.local.json` (resolved on the host from
the next session — it can disable the sandbox or add `Bash(*)`), drop a `.git/hooks/*` script the
next `git commit` runs, or repoint `core.hooksPath` / `core.fsmonitor` in `.git/config`.

A git dir is found by following a `.git` **file** (`gitdir: …`), a `commondir` file,
`.git/worktrees/*`, and nested `.git/modules/*` — including a submodule path with several segments,
whose git dir is at `.git/modules/libs/deep` under the container directory `libs` — so linked
worktrees and submodules are covered as well as a plain repository. A `core.hooksPath` naming a path
inside the workspace stays read-only in both modes, and a git directory outside the workspace is left alone.
Every work tree inside the workspace has its own `.git` **pointer file** bound read-only, so a
submodule's `sub/.git` cannot be rewritten to `gitdir: ../evil` and handed to the host's next `git -C sub`
invocation.

By default, every git directory of the workspace is bound read-only inside the namespace (issue 373).
This closes the pointer-file redirect gap where a command could create `.git/commondir` naming a
repository it built. A candidate is only accepted if it looks like a git directory (`HEAD` exists and
either an `objects` directory or a `commondir` file exists); a pointer naming the workspace root or an
ordinary directory does not bind it read-only. If a candidate that passes canonicalises to the workspace
root itself, the run is refused because the sandbox cannot make the root read-only without making the whole
workspace read-only. In read-only mode, each ancestor directory strictly between the workspace root and
every protected mount is pinned with a writable self-bind (`--bind <dir> <dir>`), so renaming or removing
a parent directory inside the sandbox fails with `EBUSY` instead of redirecting the protected mount.
Sandboxed git writes fail with an appended line explaining that the repository's git directory
is read-only inside the sandbox (`sandbox.filesystem.allowGitWrites` is off), advising the model not to retry the command
or change settings itself, and directing the user to run it outside the sandbox or allow it in `~/.book/settings.json`
(where `sandbox.excludedCommands` runs matching commands unsandboxed while `sandbox.allowUnsandboxedCommands` is true and
`sandbox.filesystem.allowGitWrites` lets sandboxed git write again; workspace settings cannot enable either).
Caveat: `git stash` in read-only mode fails silently with exit 1 and no output, so no note can match.
A sandboxed `git worktree remove` deletes the work tree and then fails on its read-only admin directory;
`git worktree prune` outside the sandbox cleans up. Setting `sandbox.filesystem.allowGitWrites: true` in
`~/.book/settings.json` restores the previous behaviour: git directories stay writable, control files are protected
per-file, and the workspace's own top-level git directory is pinned with a read-write self-bind so renaming it fails with
`EBUSY`. In that mode, pinning work tree directories is omitted so `git worktree remove` of an in-workspace
worktree does not fail halfway, which leaves the rename gap open: an ancestor holding a protected file can
still be moved away. In that mode, a git command that cannot write `.git/config` gets an appended line explaining
the read-only config. A `git config --global` or `--system` write is left out of that note: it writes
`~/.gitconfig` or the system config, not `.git/config`.

`core.hooksPath` is read from every config that can set it. **Every** `hooksPath` value in a `[core]`
section is protected rather than the first (git takes the last), unquoted `;` and `#` comments are
stripped, and `[core "x"]` is not counted as `[core]`. `[include]` and `[includeIf]` files are
followed the way git follows them — relative to the including file's directory, with `~/` expanded —
and a followed file inside the workspace is bound read-only and parsed for `hooksPath` in turn,
because a config that could add a `hooksPath` to a file the command may rewrite is a config the
command wrote. A git config is read with a **1 MiB** cap; a larger one is refused outright rather than
truncated, since a truncated read is a `hooksPath` past the cut that the namespace never saw.

**A symlinked control path is refused, not protected.** `.book`, `.git`, `.git/hooks`,
`.bookrc.json`, or any path component strictly below the workspace root on the way to every protected mount
(pointer files, hooksPath directories, included config files), discovered git directory, or pointer target
as a symlink can be bound read-only at its target, but the link itself sits in the writable workspace, so
`rm .book && mkdir .book` replaced it and every protection went with it. A component that is a symlink is
safe only if the link itself lives inside a present read-only directory mount (such as `.git/modules/x`
inside a bound `.git` in read-only mode; refused in opt-out mode) or inside a `sandbox.filesystem.denyWrite` /
`denyRead` directory (bound read-only or masked with tmpfs so changes cannot reach the host). A
sandboxed command now fails with a message naming the path and saying the sandbox cannot protect a
symlinked control path — refused before the command runs, not an aborted `bwrap` invocation.

Five consequences worth knowing:

- **Pointer-file redirects are closed by default.** Every git directory of the workspace is bound
  read-only by default (issue 373), which closes the pointer-file redirect gap where a sandboxed command
  could create `.git/commondir` naming a repository it built. Setting
  `sandbox.filesystem.allowGitWrites: true` in user settings restores writable git directories and
  reopens that gap.
- A nested repository that is **not** a submodule stays writable: nothing outside the discovered git
  dirs is touched, because a plain directory named `foo/.git` is not something Book can tell from a
  repository the workspace is not working in.
- An `[includeIf]` **condition** whose target does not exist yet is not followed. The mounts are built
  from the files that are there, so a condition that would only include a file the sandbox creates
  later is one whose `hooksPath` the host reads and the namespace never saw.
- Masking an **absent** `.book/` or `hooks/` creates the empty directory **on your disk** as a side
  effect of running a sandboxed command. Git creates `hooks/` with samples in every new repository,
  so in practice this bites a workspace that has no `.book/` yet.
- An **absent file** is skipped rather than masked: bubblewrap rejects a tmpfs over a file path and
  aborts the whole invocation, and there is nothing to protect where there is no file. An absent
  **directory** is masked, because a command that creates one inside the namespace would otherwise
  put it in the host. A `hidden-file` mask is emitted only for a **regular** file — a
  `.book/settings.local.json` that is a directory would otherwise ask for `--ro-bind /dev/null` over
  a directory, which bubblewrap rejects with "Is a directory" and which takes every command in the
  workspace down with it. `.book/settings.local.json` is the one file masked rather than bound
  read-only — with `/dev/null`, which hides the credentials in it as well as blocking the write.
  Because a trusted `filesystem.allowWrite` entry is applied after these mounts, an opt-in on a git
  dir reopens what it names, but keeps control paths strictly below it (`hooks/`, `config`, pointer files)
  read-only unless an entry names that control path directly. Every `hidden-file` mask is re-applied once
  more after the `allowWrite` opt-ins and the `denyWrite` binds: remounting `.book` writable would otherwise
  reopen `settings.local.json` for both reading and writing, and a `denyWrite` entry at or above `.book` is
  a read-only bind of the real directory that would show its contents again (issue 625).

The permission layer already asked before any file tool touched `.book/`, but a permission prompt is
one approval the user can be talked into — and a shell command is not a file tool, so the sandbox
now makes it a failure rather than a question.

### macOS (Seatbelt)

On macOS each sandboxed command runs as `sandbox-exec -D … -p <profile> -- /usr/bin/env
GIT_CONFIG_GLOBAL=/dev/null /bin/bash -c <command>`. The profile is generated per command from the
same resolved policy the bubblewrap argv is built from — the workspace, the protected control paths
above, and `sandbox.filesystem` — and starts from `(deny default)`:

- **Writes** reach the workspace, the `allowWrite` entries, and the temp directories (see below).
  The control files in the table above are read-only in both modes, `.book/settings.local.json` is
  unreadable as well, and an `allowWrite` opt-in reopens what it names exactly as it does under
  bubblewrap. A denied write fails with `Operation not permitted` rather than `Read-only file
system`; the read-only git directory note is appended for it all the same.
- **Reads** cover what bubblewrap mounts: the system directories (`/usr`, `/bin`, `/sbin`, `/opt`,
  `/System`, `/Library`, `/Applications`, `/private/etc`), the workspace, and the `allowWrite` paths.
  The home directory is not readable, as it is not mounted under bubblewrap — `~/.book`, `~/.ssh`
  and the rest stay out of reach. Git is run with `GIT_CONFIG_GLOBAL=/dev/null`, because git dies on
  an unreadable `~/.gitconfig` where it skips a missing one.
- **Renames.** A bind mount cannot be renamed; a Seatbelt rule names a path, so the profile keeps
  the workspace root and the directories bubblewrap pins from being renamed or removed, keeps every
  directory above a protected path from being created again once moved, and keeps the directories
  above `.book/settings.local.json` and every `denyRead` path in place. A consequence: a protected
  directory that does not exist yet (`.book/`, a `core.hooksPath` target) cannot be created by a
  sandboxed command, and nothing is created on your disk to mask it.
- **Temp directories** are the host's own, not a private `/tmp`: macOS tools write to the per-user
  temp directory whatever `TMPDIR` says (`mktemp`, and the `xcrun` shim behind `/usr/bin/git`), so a
  private one breaks them. `os.tmpdir()` and `/tmp` are therefore readable and writable, except
  for Book's own entries in them (`book-rewind-*`, `book-index-*`, `book-config-preflight-*`, and
  the messaging inbox's `book-socks*`) and a
  `BOOK_HOME` placed there. Book's home is denied by path wherever it is, and a temp directory that
  is or contains the home directory is not used at all.
- **Network** is the host's unless a domain rule is declared, in which case every socket is denied
  (below). Even when it is shared, a command can connect only to unix-domain sockets inside the
  workspace or an `allowWrite` path, plus the system DNS resolver: the ssh-agent, Docker and other
  local sockets are not reachable, as they are not mounted under bubblewrap.
- **Processes.** Signals and process inspection are limited to the sandbox, and the profile allows
  only a short list of system services, so `launchctl submit`, `open` and Apple Events cannot have
  an unsandboxed process run a command, and the keychain daemons are not among them. Process, IPC and sysctl rules follow Anthropic's
  [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime).

No path is ever written into the profile text: each is passed as a `-D` parameter, so a workspace
path that contains `"` or `)` stays a path. A profile `sandbox-exec` rejects fails the command
without running it. The macOS behaviour is proven by the `Sandbox (macOS Seatbelt)` CI job, which
runs a real `sandbox-exec`.

### A workspace settings layer may only tighten the sandbox

`.book/settings.json` is repository input, and so is a `settings.local.json` a clone was
force-fed. Neither can switch the sandbox off, exclude commands, or widen a writable mount; both
can turn it on, refuse unsandboxed commands, and add deny entries — and turning it on from a
workspace file also turns `autoAllowBashIfSandboxed` off, because a repository that could enable the
sandbox and pre-approve the commands in one file would not be contained by it.

`book config set` and `/config` refuse a workspace write before it happens, and they judge the
**value** rather than the key: `book config set sandbox.enabled true --local` is written, so is a
`denyRead` entry, while `sandbox.enabled false` and `filesystem.allowWrite` are refused with the file
the value belongs in. That refusal applies to the two **workspace** layers only — the user-global
`~/.book/settings.json` is not repository input, so `book config set sandbox.enabled false` (the user
scope, which is what the command targets by default) is written, as is
`/config sandbox={"enabled":true}` aimed at it. `book doctor` lists every key a workspace layer asked for and did not get, with
the resolved path and a truncated value, and a print or SDK run reports the same keys on stderr,
reading **both** workspace layers and naming the file each ignored key came from. The `enabled: true`
line is printed for the layer that actually flipped the key on — after a trusted layer enabled the
sandbox, a checked-in `enabled: true` repeats a decision the user already made and is not reported
as one it made. The full table is in
[Configuration → The sandbox](configuration.md#a-workspace-layer-may-only-tighten-sandbox).

### `Check` runs in the sandbox too

`Check` executes a project-supplied command in the project workspace, so it takes the same decision
as `Bash` — sandboxed when the sandbox is on, refused when `allowUnsandboxedCommands` is false and
it would run outside, and marked `[sandboxed]` when wrapped. It previously ran through `exec` with no
sandbox at all, so a session that refused unsandboxed commands still ran its checks unsandboxed.

`sandbox.filesystem` adjusts the default mounts, applied after the workspace bind so they take precedence:

| Key          | Effect                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| `allowWrite` | Bind the path writable inside the sandbox                              |
| `denyWrite`  | Make the path read-only where a command could write it                 |
| `denyRead`   | Mask the path — an empty tmpfs for a directory, `/dev/null` for a file |

Entries may start with `~`. Paths that do not exist are skipped — bubblewrap rejects a bind with a missing source — and the skipped entries are reported once at startup and by `book doctor`, since a skipped rule is policy you might otherwise believe is active. On macOS the same entries become Seatbelt rules: `denyWrite` not writable, `denyRead` neither readable nor writable, and missing paths are skipped the same way.

`denyWrite` only ever takes write access away; it never shows a path the sandbox did not already show. An entry inside the workspace or an `allowWrite` root is bound read-only, a writable root inside an entry becomes read-only, and an entry anywhere else changes nothing, because it was already invisible or read-only. Before issue 625, bubblewrap bound the real path read-only wherever it was. So `denyWrite: ["~"]`, which a workspace settings layer may add, showed the whole home directory to sandboxed commands, and `["/"]` overlaid the host's `/proc` and `/tmp`. To make a toolchain outside the workspace usable inside the sandbox, list it in `allowWrite` from your own settings.

`sandbox.network` **fails closed**. Neither bubblewrap nor Seatbelt has DNS or per-domain filtering, so each can only share or deny the network as a whole. If `allowedDomains` or `deniedDomains` contains anything, Book cannot honour the rule as written and disables network access entirely for sandboxed commands, with a warning. Leave both empty to share the host network.

Two further keys decide what happens _around_ that boundary. Both are consulted on every `Bash`
call, and both answer the same question — will this exact command really execute inside a
namespace? — from one shared predicate, so they can never disagree about a command:

| Key                                | Default | Effect                                                                      |
| ---------------------------------- | ------- | --------------------------------------------------------------------------- |
| `sandbox.allowUnsandboxedCommands` | `true`  | Set `false` to refuse any `Bash` command that would run outside the sandbox |
| `sandbox.autoAllowBashIfSandboxed` | `true`  | Run a genuinely sandboxed `Bash` command without a permission prompt        |

`allowUnsandboxedCommands: false` covers all three ways a command escapes: sandboxing is turned
off, the command matched an `excludedCommands` pattern, or the backend (bubblewrap, or `sandbox-exec` on macOS) is missing on this platform.
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

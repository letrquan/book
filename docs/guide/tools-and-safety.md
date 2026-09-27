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
  `new_string`, `replace_all`, Grep `glob`/`-A`/`-B`/`-C`, ApplyPatch `input`) are normalized to
  Book's canonical arguments before validation, and `invalid_arguments` errors list the allowed
  argument names.
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
  ToolSearch" would name one that already has it and cannot lift the rule.

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

## Tool discovery

`ToolSearch` matches a query by its words — tool names, aliases, intent keywords, and at least two
description words — and falls back to fuzzy matching for a misspelled name. It is callable whenever
deferred discovery exists, including eager mode, where it names the matching tools that are already
active instead of being refused.

## Permission rules and modes

`permissions.allow`, `permissions.ask`, and `permissions.deny` are matched against every tool call.
`deny` beats `ask`, and `ask` beats `allow`.

Permission _modes_ decide whether you are prompted; they never relax a `deny` rule. A rule in
`permissions.deny` blocks the matching call in every mode, including `auto` and
`bypassPermissions`, and it is evaluated before the prompt, so a denied call never reaches one.
Modes differ only in what happens to calls that no `deny` rule matched:

| Mode                | Unmatched calls                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`           | Checked against `allow`/`ask`, then prompted — except workspace reads, which run unless a rule covers them                                   |
| `acceptEdits`       | As `default`, and file mutations are approved without a prompt too                                                                           |
| `plan`              | Read-only tools only; mutations are refused until you approve a plan                                                                         |
| `auto`              | Run without a prompt                                                                                                                         |
| `dontAsk`           | Refused except for the built-in always-allowed tools (`MemorySave`) — the mode never prompts, and a user `allow` rule does not exempt a call |
| `bypassPermissions` | Run without a prompt                                                                                                                         |

**Workspace reads.** In `default` and `acceptEdits`, a `Read`, `Glob` or `Grep` that the tool can
serve runs without a prompt: a target inside the workspace, or for `Read` inside Book's memory
directory (but not its inbox). The target is resolved the way the tool resolves it: `..` is applied
and symlinks and junctions are followed, so a link inside the workspace that points out of it still
asks. A `Grep` with no `path` searches the workspace, and so does a relative `Glob` pattern: a
`pattern` is anchored to the workspace the same way a relative `Read` path is, and an absolute
pattern names its own root. A `Glob` that would start walking outside the roots
(`../**`, `.{.,x}/*`, an absolute path elsewhere) still asks. Other read-only tools (`GitStatus`, `GitDiff`, `WebFetch`, …) still ask.

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
prints, and verification runs `gpg.program` — a program the repository names. The hardening covers
**these four tools only**: `GitCommit` runs with your own `argv` and environment, exactly as before,
so your `pre-commit` and `commit-msg` hooks still run. A repository can still configure clean and
smudge filters, and those run on `status` and `diff`; Book does not suppress them, because that
would mean rewriting the command you asked for.

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

**Under an excluded subpath.** A path a root serves but whose subpath the file tools exclude — Book's
own memory inbox — is refused the same way, for the same reason, with its own code
`path_excluded` and a message that says the path is excluded. The two refusals are not
interchangeable: the remedy for an outside target is a directory to add, and there is nothing to add
for one the tools never open. Everything outside the excluded subpath stays served.

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

| The call                                         | What lets it through                                           |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Most calls                                       | A `permissions.allow` rule for it, or `--permission-mode auto` |
| One an `ask` rule covers                         | Narrowing or removing that rule (it outranks allow), or `auto` |
| A skill that asks for consent                    | A `permissions.allow` rule; `auto` still asks                  |
| A persistent background shell                    | Only `--permission-mode bypassPermissions`                     |
| A `Read`, `Glob` or `Grep` outside the workspace | Nothing: the tool cannot open it                               |

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
```

All of them take `--workspace <path>`; `book doctor` prints it for you when it is diagnosing a
directory other than the one you are in. Each invocation records one decision and leaves every
other decision — in this workspace and in every other — untouched.

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

The same resolution governs every tool that enforces a deadline of its own — `Bash`, `Check`,
`Task`, and `WebFetch`. Each declares its budget so the host's backstop outlasts it; when the two
are equal the backstop fires first and replaces the tool's report, including its output, with a
bare timeout. The backstop ranks a per-tool setting above `BOOK_TOOL_TIMEOUT_MS` exactly as the tool
does, so a lower blanket override cannot fire it ahead of `Check` or `Task`. A `timeout` argument
sets the host budget only for a tool that publishes one, so a stray value cannot pull the backstop
underneath a tool that times itself.

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

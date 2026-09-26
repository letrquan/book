# Configuration

Where settings live, what they mean, and the environment variables that override them.

## Settings files

Settings are loaded in priority order (later wins):

1. `~/.book/settings.json` (user-global)
2. `.book/settings.json` (project)
3. `.book/settings.local.json` (local, should be gitignored)
4. `--settings <path>` CLI flag

### Scopes

`book config set` and the TUI's `/config <key>=<value>` write the **user-global** layer
(`<BOOK_HOME>/settings.json`, normally `~/.book/settings.json`) unless told otherwise, so a
preference you set once applies in every checkout. Pass `--project` to write the checked-in
`.book/settings.json`, or `--local` to write the gitignored `.book/settings.local.json`.
`-g`/`--global` states the default explicitly; passing more than one scope is an error. Both
surfaces run the same guards through one shared write, so they cannot disagree about which file a
preference lands in.

A write is checked against the _merged_ configuration, not just the file it lands in, so a value
that is valid on its own but would leave a configuration nothing can load is refused before it
lands rather than bricking every later command. A configuration that is already broken stays
writable, since repairing one is what the command is for.

`book config get` and `book config list` report the _resolved_ merge of all layers by default.
Given a scope they read that one file verbatim instead, which is how you find the stray value
overriding you — the local layer resolves last, so anything left there outranks a later global
write. `book config unset <key>` removes a key from a scope (also user-global by default). A
user-global write that a workspace layer still shadows says so, and names the `unset` that clears
it.

Two groups of keys are refused in every scope. Trust decisions
(`mcp.projectServers`, `permissions.projectAllowRules`, `hooks.projectEntries`,
`commands.projectCommands`) live in `<BOOK_HOME>/trust.json` and are recorded with `book trust`.
The `shell` setting is not writable by `book config` in a workspace scope — it names the program
every `Bash` command is handed to, so edit the user-global file directly, pass `--settings`, or
use `BOOK_SHELL`.

### Model ids and provider prefixes

A `model` written as `<provider>/<model>` is resolved through the `provider` registry: the prefix
selects the base URL, credential, and model catalog. The same spelling is also how many endpoints
name a single model (`meta-llama/llama-3-70b`), so a prefix that matches nothing is not an error —
Book passes the whole id through to the default endpoint.

That fallback is silent by design for the second form, but wrong for a typo. So when you have
configured providers and the prefix matches none of them, Book says so — on stderr at startup and
inline in `book doctor` — instead of leaving `Credentials: not resolved` as the only symptom of a
misspelled provider id.

Set `BOOK_HOME` to replace the default `~/.book` user-state root. This relocates user settings,
sessions, memory, managed-agent state and worktrees, jobs, rewind snapshots, telemetry, tool output,
learned context windows (`model-windows.json`), MCP configuration, and user-level skills, commands,
agents, and `AGENTS.md` discovery. Project-local `.book/` directories are unchanged.

### Learned context windows

When a provider refuses a request for exceeding its context limit, Book records a ceiling for that
model in `<BOOK_HOME>/model-windows.json` so the next session sizes compaction against a number the
provider has actually shown it will not exceed. The value is a fraction of the refused size, never
the refused size itself, and it only ever ratchets **down** — a later refusal at a smaller size
lowers it, a larger one does not raise it. It is never read from the workspace, so a repository
cannot declare a ceiling for a clone.

A window you declare yourself always wins: set `contextWindow` on the model in settings and nothing
is learned or applied over it. `book doctor` lists every learned window with how long ago it was
learned, and `/context` and the status line mark which source the current window came from
(`declared`, `learned`, `family`, or `default`). To discard one, delete its entry from
`model-windows.json`, or delete the file to forget them all — it is rebuilt on demand.

## Example `.book/settings.json`

```json
{
  "model": "claude-opus-4-6",
  "compactStrategy": "summary",
  "compactModel": "9router/ag/gemini-3.6-flash-high",
  "effort": "high",
  "defaultMode": "default",
  "permissions": {
    "allow": ["Read(*)", "Glob(*)", "Grep(*)"],
    "deny": ["Bash(rm *)", "Write(.env)"]
  },
  "sandbox": {
    "enabled": false
  },
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash(*)", "command": "my-validator" }]
  },
  "memory": {
    "enabled": true,
    "autoSave": true,
    "requireApproval": false,
    "quarantineExternal": true
  },
  "ui": {
    "showThinking": true,
    "startupAnimation": true
  },
  "toolDiscovery": {
    "mode": "auto",
    "eagerToolCount": 10,
    "schemaTokenBudget": 8000,
    "maxLoadedTools": 15,
    "searchLimit": 5
  },
  "toolExecution": {
    "maxConcurrent": 4
  },
  "agents": {
    "mode": "adaptive",
    "maxConcurrent": 3,
    "maxSpawned": 8,
    "maxDepth": 1,
    "persist": true,
    "includeUntrackedInSnapshot": true,
    "telemetry": true,
    "retentionDays": 30,
    "checks": {
      "test": "npm test",
      "typecheck": "npm run typecheck"
    },
    "checkTimeoutMs": 120000
  }
}
```

`memory.enabled` controls loading and reading the project memory index at session start; `memory.autoSave` controls whether the model may write memories via `MemorySave` (omitting the tool and save spec when false); `memory.requireApproval` (default `false`) routes model writes to `.inbox/` for review via `/memory inbox` rather than saving directly to the approved store; `memory.quarantineExternal` (default `true`) routes memories written in sessions that read external content — a web fetch or search, an MCP tool, or agent-produced text from `Task`/`AgentRead`/`AgentGet`/`AgentWait` — to the inbox regardless of requireApproval.

`agents.checkTimeoutMs` caps one `Check` run (default 120 s, maximum 2 h). A check that exceeds it
is killed and reported as `check_timed_out` — explicitly _not_ as a failing check, so an agent does
not "fix" code that was passing. Raise it for repositories whose full suite runs longer than the
default; `npm test` here builds first and routinely does.

`agents.taskTimeoutMs` caps one foreground `Task` delegation. Precedence is `agents.taskTimeoutMs`,
then `BOOK_TOOL_TIMEOUT_MS`, then the 30 min default, and the host's backstop ranks them the same
way, so it always outlasts the ceiling. Both clocks start when the `Task` call does, so a slow
spawn (a worktree snapshot) counts against the ceiling instead of letting the backstop fire first
and lose the child's partial result. The registry's 120 s default assumed a fast model; on a
route where one max-effort turn takes minutes the child was cut off mid-survey, its result
discarded, and — because nothing stopped it — it ran and billed for an hour afterwards. When the
ceiling passes the child is now stopped, and the parent gets whatever the child had finished: its
last complete assistant text and its summary, both often empty when the ceiling lands mid-turn,
plus the agent id. The stopped child holds no further result, so there is nothing more to fetch.
Cancelling the parent stops the child too, including a cancel that lands while the child is still
being spawned.

The run `Task` waited on never comes back to the parent as a completion notification, stopped or
not: `Task` already returned its result, and the notification only made the parent run another
turn to re-read it. A later run of the same child does report back, because nothing is waiting on
it. That covers an `AgentSend` follow-up, a re-run after Book restarts, and a queued message
after a failed run.

## Environment variables

| Variable                                                                                          | Purpose                                                                            |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `BOOK_API_KEY`                                                                                    | Default API key (or `{env:VAR}` in provider settings)                              |
| `BOOK_BASE_URL`                                                                                   | Default OpenAI-compatible base URL                                                 |
| `BOOK_MODEL`                                                                                      | Default model                                                                      |
| `BOOK_PROVIDER`                                                                                   | `anthropic` \| `openai` \| `auto`                                                  |
| `BOOK_EFFORT`                                                                                     | Thinking effort level                                                              |
| `BOOK_HOME`                                                                                       | User-state root (default `~/.book`)                                                |
| `BOOK_SHELL`                                                                                      | Shell for `Bash`: `bash`, `pwsh`, `powershell`, `cmd`, or a path                   |
| `BOOK_WORKSPACE`                                                                                  | Default workspace                                                                  |
| `BOOK_MAX_TOKENS` / `BOOK_MAX_TURNS`                                                              | Generation / turn limits                                                           |
| `BOOK_COMPACT_MODEL`                                                                              | Model used only for compaction checkpoints                                         |
| `BOOK_RETRY_*` / `BOOK_REQUEST_TIMEOUT_MS` / `BOOK_STREAM_STALL_TIMEOUT_MS` / `BOOK_TOOL_RETRIES` | Retry and timeout tuning                                                           |
| `BOOK_TOOL_TIMEOUT_MS` / `BOOK_TOOL_TELEMETRY_DIR`                                                | Tool timeout (`Bash` included) and telemetry location                              |
| `BOOK_WEB_ALLOW_HTTP`                                                                             | Opt into plain HTTP for `WebFetch` (disabled by default)                           |
| `BOOK_WEB_ALLOW_PRIVATE_NETWORK`                                                                  | Opt into local/private web destinations for every `WebFetch` (disabled by default) |
| `BOOK_WEB_MAX_REDIRECTS`                                                                          | Same-origin redirect limit for `WebFetch` (default 5, maximum 10)                  |
| `BOOK_TUI_RENDERER`                                                                               | `safe`, `incremental`, or experimental scroll renderer                             |
| `BOOK_DEBUG` / `BOOK_DEBUG_UI` / `BOOK_DEBUG_RENDER` / `BOOK_DEBUG_FLOW`                          | Debug logging flags                                                                |
| `BOOK_DEBUG_FILE` / `BOOK_DEBUG_STDERR` / `BOOK_DEBUG_MAX_BYTES` / `BOOK_DEBUG_BACKUPS`           | Debug log destination and rotation controls                                        |

`WebFetch` requires HTTPS by default, validates DNS results and the address used by the network
connection, blocks private/special-use destinations, and stops on cross-origin redirects so the
new origin receives its own permission decision. A cross-origin redirect is reported as such even
when its target is a private destination, since that target is one the model did not ask for. It
returns Markdown by default; `format` can be `markdown`, `text`, or sanitized `html`. `WebSearch`
works without configuration through the built-in Exa MCP provider and accepts optional `limit`,
`domains`, `recencyDays`, and `country` hints. Its provider endpoint is built in and cannot be overridden through settings or environment
variables.

An IPv6 address in one of these IPv4-embedding ranges is judged by the IPv4 address it carries:
IPv4-mapped `::ffff:0:0/96`, SIIT's IPv4-translated `::ffff:0:0:0/96`, IPv4-compatible `::/96`,
NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, and Teredo `2001::/32`, where either the server or the
client address being private blocks it. An ISATAP address (interface identifier `0:5efe` or
`200:5efe` followed by an IPv4 address, RFC 5214) is refused when that IPv4 address is, whatever
its prefix. In the local-use NAT64 prefix `64:ff9b:1::/48`, an address laid out like the /96 (bits
48-95 zero) is judged by its last 32 bits, and any other shape is blocked, because where its IPv4
bits sit depends on a prefix length only the local network knows.

So on a network whose NAT64 uses another layout inside `64:ff9b:1::/48`, such as the prefix
`64:ff9b:1:fffe::/96`, every address in it is refused, public or not, and `WebFetch` cannot reach
IPv4-only sites through DNS64 there. Book has no setting that names the local prefix: decoding by a
configured prefix would turn a wrong setting into a way past the policy, for a layout few networks
use. The only way through is `BOOK_WEB_ALLOW_PRIVATE_NETWORK=true`, which turns the private-network
check off for every destination. A network-specific NAT64 prefix outside `64:ff9b::/96` and
`64:ff9b:1::/48` (RFC 6052) is not recognized either: an address in it is judged as plain IPv6,
whatever IPv4 host it reaches.

The TUI defaults to the full-frame `safe` renderer on Windows to avoid ConPTY footer corruption
during deep transcript scrolling. Other interactive terminals default to `incremental`. Set
`BOOK_TUI_RENDERER=incremental` to opt into incremental rendering explicitly on Windows.

## Themes

Book uses the `rubric` theme by default. It is set like a rubricated manuscript: the body is in ink (warm ivory and greys), and one cinnabar red is kept for the marks you navigate by. Those marks are the pilcrow `¶` that opens each of your turns and prompts the composer, the section sign `§` before a heading, list markers, the drop cap on an empty page, and the ink of Book's spinner: a quill that writes a flourish, `∞`, dot by dot while the agent works, the ink fresh in red at the nib and drying to grey behind it. The agent writes in ink, so red never reads as an alarm. Errors are rose and warnings amber, to stay distinct from the rubric.

The layout follows the same idea. Your turns hang a red `¶` in the margin and are set in italic, so your words read as a different voice from the agent's. The composer and the menus that open above it are drawn as hairlines rather than boxes. Tables are ruled the way a book sets them, with no vertical lines. The status line carries a folio, the turn count in lowercase Roman numerals, at its right edge. An empty session opens on a title page: a five-row drop cap B in rubric, the rest of the word, a rule and a table of contents. The contents list this workspace's five most recent sessions as chapters, with Roman numerals, dot leaders and each one's age where a book prints the page, and `/resume` opens one. Before a first session, the contents list what a new reader needs, with the key to press as the page. When a menu shrinks the transcript, the page folds to its drop cap and never cuts through a glyph. Decision prompts such as the permission prompt are headed by a rule led by the same `¶` rather than drawn as boxes.

The transcript keeps the agent's reading out of the way. In the default compact transcript, a run of read-only calls (`Read`, `Glob`, `Grep`, the git read tools, `ToolSearch`, task lookups, `BashOutput`, session history) collapses into one row: `✓ Read config.ts, loader.ts   2 files · 3 searches`. The check is grey because nothing changed. The run can span one parallel batch or several turns in a row. Edits, `Bash` (even a read-only command, since the transcript cannot tell), web and MCP calls, delegation, failures, anything awaiting permission, and reads that reach outside the workspace keep their own rows. Ctrl+O's detailed transcript shows every call, and so does screen-reader mode. A row you have expanded is never folded.

Two other built-in palettes use the same layout. `folio` swaps the red for a single gilt accent and uses it on the spinner as well. `apple` is the previous palette: near-black neutral surfaces, bright grey text, a blue composer and user accent, cyan for the agent, and a distinct hue per role. Select one with `"theme": "folio"` or `"theme": "apple"` in `settings.json`. A palette changes colours only: the layout above applies to every theme.

Project themes can override any token in `.book/themes/<name>.json`, starting from `rubric`:

```json
{
  "brand": "#AFC19D",
  "userAccent": "#D3A17E",
  "surface": "#20221D",
  "surfaceActive": "#30362B",
  "border": "#4B4D45",
  "selectionText": "#F3EEE4",
  "assistantAccent": "#AFC19D",
  "toolRail": "#6B7164"
}
```

## Tool-use telemetry

When `observability.toolTelemetry` is enabled (default), Book appends one JSON line per finalized tool call to `~/.book/telemetry/tool-use.jsonl` (override the directory with `BOOK_TOOL_TELEMETRY_DIR`). Each record captures the canonical tool, the final status the model saw, a derived `isFailure` flag (`error`/`timed_out` only — permission blocks, plan-mode blocks, user declines, and cancellations are never counted as failures), the error code, duration, retries, model, and subagent attribution. The write is best-effort and off the hot path; it never blocks or fails a session, and the active log is size-rotated into a single `.1` backup.

`book tool-stats` reads this log and reports, per tool, calls / failures / fail rate / p50 / p95 duration / retry rate, plus a per-model split and the most frequent error codes:

```
$ book tool-stats
Tool use — 1,204 calls across 37 sessions (2026-06-30 → 2026-07-27)
18 failed (1.5%)

TOOL          CALLS   FAIL   FAIL%      P50      P95   RETRY%
Bash            412     12    2.9%    120ms    2.1s      4.4%
ApplyPatch      210      4    1.9%     38ms    140ms     5.7%
Read            402      0    0.0%     15ms     34ms     0.0%
```

Use `--json` for a machine-readable aggregate, `--since <days>` to change the window, `--all` for full history, and `--prune` to drop records older than the window from disk. `observability.toolTelemetryRetentionDays` sets the default reporting window and the `--prune` target; disk use is otherwise bounded by log rotation. Records store outcomes and hashes only, never prompts or file contents. This is separate from the ephemeral in-session counters shown by `/usage`.

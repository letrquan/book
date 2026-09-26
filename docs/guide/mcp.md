# MCP servers

Connecting Book to Model Context Protocol servers.

## Adding and approving servers

MCP declarations use the interoperable `{"mcpServers": {"name": {...}}}` shape. User-global
servers live at `~/.book/mcp.json` (or `$BOOK_HOME/mcp.json`) and project declarations live at
`.mcp.json`. A declaration may use the legacy stdio shape or an explicit transport:

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

Supported transports are `stdio`, Streamable HTTP (`http`), and legacy SSE (`sse`). Variable
references support `${NAME}` and `${NAME:-fallback}`; values are never shell-evaluated. URLs must
be absolute HTTP(S) URLs without embedded credentials. Header names are shown in status output,
but header values are redacted from logs, prompts, reports, and diagnostics.

Project servers are untrusted repository-controlled input. Book displays the exact non-secret
target and asks for one-time approval before launching or connecting; the decision is stored in
`~/.book/trust.json` and is invalidated when any command, argument, environment value,
working directory, URL, transport, or header value changes. Headless and SDK runs skip unapproved
project servers. `/mcp` shows live status in the TUI; `book mcp list|get|add|remove` manages
declarations. Permission rules may target one server (`mcp__github`) or one exact tool
(`mcp__github__create_issue`).

Servers may ask the user for input mid-call through MCP form elicitation — a project picker, a
confirmation, a missing parameter. The interactive TUI answers those requests: the form shows which
server is asking, offers its fields (text, number, yes/no, and choice lists, which filter as you
type), and returns the answer inside the still-open tool call. `D` declines, `Esc` cancels, and
either way the server is told rather than left waiting. URL-mode elicitation is not supported and is
declined.

Only the TUI can prompt. Headless (`--print`) runs, and SDK runs without an `onElicit` callback, do
not declare the capability at all, so a server fails such a request itself instead of blocking on a
prompt nobody will see. For unattended runs, pass the value explicitly in the tool call or give the
server a default — for example the Azure DevOps server reads `ado_mcp_project` from its `env` block
and skips the project prompt entirely.

Legacy `.bookrc.json` is still supported but deprecated. Use `--no-settings` to skip all `settings.json` layers (defaults + legacy only).

Scalar values use the highest-priority layer. Permission rules, hook lists, and
`additionalDirectories` accumulate in layer order; directory entries are normalized and
deduplicated. Other arrays are replaced by the highest-priority layer that defines them.

Two exceptions apply to the **project** layer (`<workspace>/.book/settings.json`), because that
file is checked in and controlled by whoever wrote the repository:

- A `permissions.allow` rule it declares is withheld until you approve it. `ask` and `deny` rules
  apply immediately — they only ever restrict. `book doctor` lists withheld rules and prints the
  `book trust rule ...` command that grants them.
- Keys recording a trust decision — `mcp.projectServers`, `permissions.projectAllowRules`,
  `hooks.projectEntries`, and `commands.projectCommands` — are ignored from **both** workspace
  layers, so a repository cannot approve itself. They are not settings you write: decisions live
  in `~/.book/trust.json`, keyed by workspace path, and `book trust` is what records them.
  `book config set` refuses these four paths outright rather than writing a value nothing reads.
  Putting them in the gitignored `.book/settings.local.json` was not enough — `.gitignore` does
  not stop a force-added file from reaching a clone, so a repository could ship approvals for the
  hooks, servers, and commands it also shipped. A store outside the workspace is one nothing the
  repository ships can reach. An unreadable store records no decisions, which withholds the gated
  input rather than releasing it.

`book config set` and TUI preference changes validate the complete local document before writing.

Set `defaultMode` in user-global `~/.book/settings.json` to choose the permission mode used by
the TUI, print mode, scrollback, and SDK when no invocation-specific mode is supplied. The
`--permission-mode` CLI option and SDK `permissionMode` option override that default.
Project and local settings cannot select `bypassPermissions` as the startup default. Setting
`disableBypassPermissionsMode` to `true` also blocks explicit bypass requests and removes bypass
from the TUI mode cycle.
Writes use an atomic sibling-file replacement, and malformed or non-object
`.book/settings.local.json` files are never overwritten. The reported error includes the file and
invalid setting path; provider secrets are redacted.

Inside the TUI, `/config` opens a visual settings menu. Use it to change the main model, compact
strategy, compact model, effort, model memory writes, startup fire, or the model assigned to
each managed-agent profile. Choosing a row opens that setting's picker and returns to the menu on
the same row when it closes, so one `/config` covers as many settings as you want to change.

`/config <key>=<value>` is the same command in typed form, and it runs the same guarded write as
`book config set`: it refuses a key nothing reads, checks the resulting merge before writing, and
takes the same `--global` / `--project` / `--local` flags (at most one, before or after a
`compact-model` keyword).

Seven settings are held by the running session rather than re-read from `settings` each turn —
`model`, `compactModel`, `effort`, `defaultMode`, `ui.showThinking`,
`ui.startupAnimation` and `memory.autoSave`. Each is handed to the same code path its menu row
uses, so `/config model=…` switches the session exactly as `/model …` does rather than writing a
file this session will not re-read. They land in the layer that setting belongs to: user-global
by default. Everything else defaults to the user-global layer.

Naming a scope that setting already uses is the same request as naming none. Naming a _different_
one is a request to write that one file, and the reply then says the change waits for the next
start — because that is what a file write on its own does — and warns when a later-resolved layer
still decides the value.
The startup fire plays only for a new, empty launch session and is skipped automatically for
screen-reader or reduced-motion mode. Press Esc to skip it.

TUI preference changes are saved by whose choice they are. Preferences about how Book behaves for
_you_ — model, effort, compact model, permission default mode, provider registries and API keys,
thinking display, startup animation, model memory writes — are written to the user-global
`~/.book/settings.json` and follow you across projects. What is genuinely about _this_ repository
stays in `.book/settings.local.json`: skill overrides, approved permission rules, and per-profile agent
models. Set `ui.startupAnimation` to `false` in `~/.book/settings.json` to disable the
effect everywhere.

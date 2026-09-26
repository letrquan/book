# Book guides

The [README](../../README.md) gets you from install to your first session. These pages are the
full reference, one area each.

| Guide                                                   | What it covers                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Command line, print mode, and the SDK](cli.md)         | every flag, `book -p` for scripts and CI, output formats, exit codes, the TypeScript SDK         |
| [Configuration](configuration.md)                       | the settings files and their scopes, model ids, an example `settings.json`, environment variables, themes, telemetry |
| [Tools, permissions, and safety](tools-and-safety.md)   | how Book reads and edits files, which shell it runs, timeouts, permission rules and modes, hooks, the sandbox |
| [Slash commands and skills](commands-and-skills.md)     | built-in commands, writing your own in `.book/commands/`, commands in print mode, skills         |
| [MCP servers](mcp.md)                                   | adding servers, transports, project-server approval, permissions for MCP tools                   |
| [Managed agents and code review](agents-and-review.md)  | background explorer, patcher, and validator agents; the `/review` pipeline                       |
| [Long and unattended runs](long-runs.md)                | letting a run continue past the first answer, and what compaction carries forward                |
| [Feature reference](features.md)                        | everything Book does, in one list                                                                |
| [Developing Book](development.md)                       | working from a checkout, the test tiers, maintenance jobs, releases                              |

Status and history live elsewhere: [current state](../current-state.md) is the verified snapshot
of what works today, [MILESTONES.md](../../MILESTONES.md) the roadmap, and
[CHANGELOG.md](../../CHANGELOG.md) the release notes.

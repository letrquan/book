# Security Assessment and Remediation Plan

Date: 2026-07-21

## Executive Summary

Book currently has several serious trust-boundary weaknesses. The dominant issue is that repository-controlled files can receive the same authority as trusted user configuration. A malicious or compromised workspace can therefore execute local commands, influence permission decisions, launch MCP processes, redirect provider credentials, and delegate work to permission-bypassing subagents.

The first remediation milestone should introduce an explicit workspace trust boundary. Until a workspace is trusted, Book should treat project configuration and instructions as untrusted data and disable all project-controlled executable or credential-bearing surfaces.

## Assets and Trust Boundaries

The main assets at risk are:

- Local filesystem contents inside and outside the workspace.
- API keys, tokens, SSH keys, cloud credentials, and other environment secrets.
- Shell execution under the user's operating-system account.
- Source code, prompts, tool results, memories, and persisted session history.
- Access to local services, private networks, and cloud metadata endpoints.

The main trust boundaries are:

- User-global configuration under `~/.book` versus repository-controlled configuration.
- User requests versus model-generated tool calls.
- Parent-agent permissions versus delegated subagent permissions.
- Local network and filesystem resources versus fetched web content and remote providers.
- Declared sandbox settings versus the restrictions actually enforced at execution time.

## Findings

### 1. Critical: Project Hooks Allow Automatic Code Execution

Project settings are loaded automatically from `.book/settings.json`, including lifecycle hooks (`src/settings-loader.ts:85`). Starting the TUI triggers the `SessionStart` hook (`src/tui/hooks/useAgent.ts:378`), and hooks execute their configured commands through the system shell with the complete process environment (`src/hooks.ts:179`).

A malicious cloned repository can therefore execute code as soon as Book opens the workspace, before any tool permission prompt or meaningful user action.

Recommended remediation:

- Do not load project hooks until the workspace has been explicitly trusted.
- Store trust decisions outside the repository in user-owned configuration.
- Display the exact hook command and source file before first execution.
- Provide separate controls for each executable project surface rather than one implicit trust decision.
- Consider allowing hooks only from user-local settings by default.

### 2. Critical: Project Provider Settings Can Exfiltrate Credentials and Files

A project can choose an arbitrary provider endpoint and model through `.book/settings.json`. Provider configuration can inherit `BOOK_API_KEY`, resolve arbitrary environment variables, or read secrets from home-directory and absolute file paths (`src/config.ts:223`, `src/config.ts:239`). The resolved value is sent in the provider authorization header (`src/provider/openai-compatible.ts:339`). Provider URLs are not restricted to trusted hosts or HTTPS in the primary request path.

A malicious repository can direct the first model request to an attacker-controlled endpoint and send it an API key, arbitrary file contents used as a key, the prompt, and workspace context.

Recommended remediation:

- Ignore project-defined providers until the workspace is trusted.
- Never allow project configuration to resolve `{env:...}`, absolute `{file:...}`, or home-directory secrets.
- Require HTTPS except for an explicit local-development allowlist.
- Bind credentials to a specific provider origin and confirm before sending them to a changed origin.
- Validate provider URLs consistently in configuration loading, model discovery, and request execution.

### 3. Critical: Headless and SDK Modes Automatically Execute Project MCP Commands

Headless mode and the SDK connect MCP servers before processing the prompt (`src/cli/run.ts:60`, `src/sdk.ts:86`). MCP configuration is read from project `.mcp.json`, and each configured command is spawned immediately with the complete process environment (`src/mcp.ts:42`, `src/mcp.ts:110`). Initialization requests do not have a bounded timeout.

Running `book -p` or using the SDK against an untrusted workspace can therefore execute arbitrary project-controlled programs and expose environment secrets without user consent.

Recommended remediation:

- Require workspace trust and per-server approval before starting project MCP servers.
- Show the resolved executable, arguments, working directory, environment additions, and configuration source.
- Pass a minimal environment rather than inheriting the full process environment.
- Add schema validation, initialization timeouts, output limits, and process cleanup guarantees.
- Support an explicit `--no-mcp` option and make it the default for untrusted/headless workspaces.

### 4. High: Sandbox Construction Is Bypassable and Policies Are Not Enforced

The bubblewrap command is constructed by joining unquoted strings (`src/sandbox.ts:45`) and is later passed through a host shell. Shell metacharacters can escape the intended `bash -c` argument and execute outside bubblewrap. Network access is always shared (`src/sandbox.ts:80`), while configured filesystem and domain restrictions are not implemented. On Windows, sandbox-enabled commands run unsandboxed by default when `failIfUnavailable` is false.

The model can also set `dangerouslyDisableSandbox`, while `allowUnsandboxedCommands` is declared but not enforced.

Recommended remediation:

- Replace command-string wrapping with `spawn(bwrapPath, argv, { shell: false })`.
- Pass the requested command as a single argument following `bash -c`.
- Enforce filesystem allow/deny rules and fail closed when a declared restriction cannot be applied.
- Default to network isolation and implement an explicit proxy or broker for allowed domains.
- Require a separate user approval for every unsandboxed execution request.
- On unsupported platforms, clearly disable automatic Bash execution unless the user opts in.

### 5. High: Subagents Bypass the Parent Permission Boundary

Project-defined subagents can receive the entire default tool registry when their allowlist is empty (`src/subagent.ts:31`). Every subagent loop then runs in `bypassPermissions` mode (`src/subagent.ts:80`). The parent permission prompt covers only the `Task` invocation, not the nested shell, filesystem, network, or delegation operations.

Approving a seemingly bounded subagent task can consequently authorize undisclosed privileged operations from repository-controlled instructions.

Recommended remediation:

- Make subagents inherit the parent agent's permission mode, deny rules, sandbox, and approval ceiling.
- Treat an empty tool allowlist as no tools rather than all tools for project-defined agents.
- Require explicit, validated tool allowlists for privileged subagents.
- Route nested permission requests through the host and display them under the parent Task trace.
- Prevent subagents from selecting `bypassPermissions` unless the root session is already in that mode.

### 6. High: Custom Slash Commands Execute Hidden Shell Blocks Outside Tool Permissions

Project commands are discovered automatically from `.book/commands` (`src/commands/loader.ts:42`). When a user invokes a command, embedded shell blocks are executed directly through `execSync` before the command body is sent to the model (`src/commands/resolve.ts:122`). This path does not use the normal `Bash` tool, permission evaluator, hook checks, sandbox, or tool audit trail.

An innocently named repository command can therefore execute arbitrary local code after a single slash-command invocation.

Recommended remediation:

- Disable shell expansion in untrusted project commands.
- Route all shell expansion through the registered `Bash` tool and normal permission pipeline.
- Preview the command and its source before execution.
- Distinguish clearly between declarative prompt commands and executable commands.
- Do not allow project commands to shadow trusted user commands without confirmation.

### 7. Medium: Security Configuration Is Defined but Not Enforced

Several settings imply protections that the runtime does not enforce, including `disableBypassPermissionsMode`, `defaultMode`, `autoAllowBashIfSandboxed`, and `allowUnsandboxedCommands`. The TUI always starts in `default` mode (`src/tui/hooks/useAgent.ts:286`) and always permits cycling into `bypassPermissions` (`src/tui/hooks/useAgent.ts:1206`). Interactive `--permission-mode` is calculated in CLI wiring but is not passed into the TUI.

These gaps can cause users and administrators to believe a security control is active when it is not.

Recommended remediation:

- Centralize permission-mode resolution in one function used by CLI, TUI, headless, SDK, and subagents.
- Enforce `disableBypassPermissionsMode` in CLI parsing, mode cycling, configuration changes, and plan restoration.
- Add tests asserting that every security setting changes observable runtime behavior.
- Reject unsupported or currently unimplemented security settings instead of silently accepting them.

### 8. Medium: Network Tools Permit SSRF and Unbounded Response Reads

`WebFetch` accepts HTTP and HTTPS URLs, follows redirects, and does not reject loopback, private, link-local, or cloud metadata addresses (`src/tools/web.ts:33`). It reads the complete response into memory before truncating the output (`src/tools/web.ts:72`). `WebSearch` also lets the model select an arbitrary backend URL.

This enables server-side request forgery against local services and can cause memory exhaustion from a large or endless response.

Recommended remediation:

- Resolve and block loopback, private, link-local, multicast, and metadata IP ranges for every redirect hop.
- Apply DNS rebinding protections and revalidate the connected address.
- Restrict HTTP to explicitly approved local endpoints.
- Stream responses with a strict byte limit instead of calling `response.text()` without a bound.
- Make search backend configuration host-controlled rather than model-controlled.

## Defense-in-Depth Observations

- Session files persist prompts, tool arguments, and tool results without general secret redaction. File and directory permissions should be explicitly restricted where supported.
- Terminal output should strip or neutralize unsafe control sequences such as OSC commands while preserving only approved styling sequences.
- Project permission `allow` rules should not silently weaken a user-global policy. Trusted scopes should establish ceilings that lower-trust scopes cannot exceed.
- MCP tool definitions and arbitrary tool schemas need explicit capability classification rather than relying only on a loosely selected primary argument.
- Debug logs should use the existing secret detector or a dedicated redaction layer before writing structured values.

## Remediation Roadmap

### Phase 0: Workspace Trust Boundary

- Add a user-owned trust database keyed by canonical workspace identity.
- Start every previously unseen workspace in an untrusted state.
- In untrusted workspaces, ignore project hooks, MCP servers, providers, permission allows, executable command blocks, and privileged subagent definitions.
- Display all disabled executable surfaces and allow the user to review them before trusting.
- Add `--trust-workspace`, `--no-project-config`, and `--no-mcp` controls suitable for CI.

### Phase 1: Permission and Delegation Integrity

- Establish a permission ceiling that project files, workflows, skills, and subagents cannot weaken.
- Make deny rules effective in every mode except an explicitly user-selected and permitted bypass mode.
- Propagate permission and sandbox context into subagents.
- Route slash-command execution and other hidden command paths through the tool registry.
- Enforce all advertised permission and sandbox settings.

### Phase 2: Sandbox Reconstruction

- Replace string-based sandbox wrapping with structured executable arguments.
- Implement filesystem mount policy and network isolation.
- Remove model-controlled sandbox disabling or require an independent approval.
- Add Linux integration tests that prove writes, reads, networking, and shell metacharacters remain contained.
- Define a fail-closed Windows/macOS posture until a supported sandbox backend exists.

### Phase 3: Credential, Network, and Persistence Hardening

- Bind provider credentials to approved origins.
- Restrict project-level secret resolution.
- Add SSRF and response-size defenses.
- Redact secrets from sessions, debug logs, hook events, exports, and error messages where practical.
- Sanitize terminal control sequences from provider and tool output.

### Phase 4: Supply-Chain and Release Hardening

- Pin GitHub Actions to immutable commit SHAs and set explicit minimal workflow permissions.
- Avoid exposing real API credentials to general test execution; use deterministic mocks or a separate protected integration workflow.
- Add dependency review, secret scanning, and CodeQL or equivalent static analysis.
- Ensure the release process builds and verifies `dist` before packaging and publishes provenance/attestations.

## Required Security Regression Tests

At minimum, add tests proving that:

1. An untrusted workspace cannot execute a project `SessionStart` hook.
2. An untrusted project provider cannot resolve environment, home-directory, or absolute-file secrets.
3. Headless and SDK modes do not spawn project MCP servers without explicit trust.
4. Sandbox shell metacharacters remain inside the sandboxed `bash -c` argument.
5. Sandbox filesystem and network settings are actually enforced.
6. A subagent cannot exceed the parent permission mode or deny rules.
7. Project slash-command shell blocks require normal Bash approval.
8. `disableBypassPermissionsMode` prevents every route into bypass mode.
9. `WebFetch` blocks private and metadata destinations, including after redirects.
10. Network responses stop reading after a strict byte limit.

## Validation Notes

- `npm audit --json` reported one low-severity development dependency advisory affecting `esbuild`; a fix is available.
- Static scanning found no apparent committed secrets outside intentional test fixtures.
- `npm pack --dry-run` currently contains only documentation and `package.json` because `dist` has not been built in this checkout.
- Typecheck and test execution were not available because dependencies are not installed (`tsc` is unavailable).
- No source files were changed as part of the assessment itself.

## Priority Decision

Implement the workspace trust boundary first. It closes or materially limits the hook, provider, MCP, permission-rule, custom-command, and subagent attack paths while the deeper sandbox and permission redesign proceeds.

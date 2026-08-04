# Security Assessment and Remediation Plan

- **Original assessment:** 2026-07-21
- **Current status:** Updated 2026-08-04; active risk register
- **Priority:** Add an explicit workspace trust boundary before treating cloned project
  configuration as executable policy.

This document describes current residual risks, not a claim that Book has no security controls.
Since the original assessment, web SSRF defenses, permission-mode resolution, project bypass-mode
sanitization, strict agent tool capabilities, bounded MCP/process lifecycles, secret-safe telemetry,
and several persistence boundaries have been hardened. The central workspace-trust gap remains.

## Current Risk Summary

| Area | Status | Current state |
| --- | --- | --- |
| Workspace trust | Open - critical | There is no user-owned trust database or first-open review gate. |
| Project hooks | Open - critical | Project hook entries can execute during lifecycle events. |
| Project providers/credentials | Open - critical | Lower-trust project provider blocks can select endpoints and credential references. |
| Project MCP commands | Open - critical | Project MCP configuration can start local processes in headless/SDK flows. |
| Shell sandbox | Open - high | Bubblewrap is optional, Linux-oriented, and constructed as a wrapped command string; declared filesystem/domain policy is incomplete. |
| Delegation boundary | Partial - high | Agent tool lists are strict and managed agents inherit bounded capabilities, but legacy subagents execute their allowed surface without nested interactive prompts. |
| Custom command shell substitution | Open - high | `!` shell substitutions execute asynchronously with bounds, but outside the normal Bash permission/hook/sandbox audit path. |
| Permission mode settings | Largely resolved | Startup mode resolution is shared, project/local settings cannot select bypass as default, and `disableBypassPermissionsMode` blocks explicit/cycled bypass. |
| Web SSRF/response bounds | Resolved | HTTPS/public-network defaults, DNS/connect-time validation, redirect revalidation, and response limits are implemented. |
| Snapshot privacy | Documented residual risk | Managed snapshots may store non-ignored untracked files in the local Git object database; rewind intentionally snapshots broad local state. |
| Supply chain | Open - medium | Actions use version tags rather than immutable SHAs; provenance/attestation and advanced scanning are not configured. |

## Assets and Trust Boundaries

Protect local files, API/SSH/cloud credentials, shell authority, provider prompts and results,
memories/sessions, local/private network access, and persisted worktree/job/snapshot data.

The important boundaries are user-global state versus repository-controlled state, user approval
versus model-generated calls, root permissions versus delegated capabilities, local resources
versus remote content/providers, and declared sandbox policy versus restrictions actually enforced
by the operating system.

## Open Findings

### 1. Project-Controlled Executable Surfaces Need Trust Gating

`.book/settings.json`, project MCP configuration, custom commands, agent definitions, and project
instructions are discovered without a persistent workspace trust decision. Hooks and MCP commands
can execute local programs; custom commands can contain shell substitutions; provider settings can
change the remote origin used for model traffic.

Required remediation:

- Store trust outside the repository, keyed by canonical workspace identity.
- Start unseen workspaces untrusted and enumerate every disabled executable/credential-bearing
  surface before opt-in.
- Gate project hooks, MCP commands, providers, permission allows, command shell substitutions, and
  privileged agents separately or behind a clearly reviewed trust decision.
- Add CI-safe controls such as `--no-project-config`, `--no-mcp`, and an explicit trust input.

### 2. Provider Credentials Need Origin Binding

Provider configuration supports environment/file-backed credentials and arbitrary compatible base
URLs. Project scope must not be able to redirect a trusted credential to a new origin.

Required remediation:

- Bind credentials to approved HTTPS origins and confirm origin changes.
- Restrict project/local `{env:...}` and `{file:...}` references to explicitly approved sources.
- Apply the same URL policy to model discovery and model requests.
- Permit HTTP only for explicitly approved local development endpoints.

### 3. Sandbox Enforcement Does Not Match the Full Schema

The current bubblewrap wrapper mounts the workspace read/write, shares the host network, and does not
fully enforce `filesystem` or domain policy. When bubblewrap is unavailable, commands may run
unsandboxed unless `failIfUnavailable` is enabled.

Required remediation:

- Execute bubblewrap with structured argv and `shell: false`.
- Enforce read/write/deny mounts and a defined network policy.
- Remove model-controlled sandbox escape paths or require an independent approval.
- Define fail-closed behavior on Windows/macOS until a supported backend exists.
- Add Linux integration tests for shell metacharacters, filesystem boundaries, and networking.

### 4. Nested and Hidden Execution Must Reuse the Tool Pipeline

Strict agent allowlists and parent capability intersections reduce delegation risk, but legacy
subagents and custom command shell substitutions still avoid the normal interactive Bash approval
surface for each nested command.

Required remediation:

- Route command substitutions through registered Bash preparation, hooks, permission evaluation,
  sandboxing, cancellation, and telemetry.
- Ensure every delegated execution remains below the root permission/sandbox ceiling.
- Preserve source attribution so the UI identifies which command, skill, or agent requested work.

## Completed Hardening

- `WebFetch` rejects credentials in URLs, requires HTTPS by default, blocks private/special-use
  destinations, validates resolved and connected addresses, bounds redirects and bodies, and stops
  at cross-origin redirects for a new permission decision.
- `WebSearch` uses a fixed HTTPS provider endpoint and bounded validated responses.
- Project/local settings cannot select `bypassPermissions` as the default, and a trusted global
  `disableBypassPermissionsMode` ceiling cannot be weakened by lower-trust layers.
- Agent definitions treat missing/empty tools as no tools; `*` is explicit inheritance and
  argument rules are checked at execution.
- Managed-agent persistence uses ownership leases, bounded recovery, atomic writes, and safe
  diagnostics that omit prompts, transcripts, credentials, and environment values.
- Tool schemas are closed and normalized before permission/hook checks; aliases cannot bypass
  path-scoped rules.

## Required Regression Tests

1. An untrusted workspace cannot execute project hooks, MCP commands, provider redirects, command
   substitutions, or privileged agent definitions.
2. Lower-trust provider settings cannot resolve or redirect user-global credentials without
   approval.
3. Sandbox shell metacharacters remain inside the sandboxed command argument.
4. Sandbox filesystem and network settings change observable OS-level behavior.
5. Delegated work cannot exceed root permission, sandbox, network, or tool ceilings.
6. `disableBypassPermissionsMode` prevents every route into bypass mode.
7. Web requests continue to block private/metadata destinations after DNS and redirects and stop at
   the configured response limit.
8. Sessions, exports, logs, feedback reports, and terminal rendering apply their documented
   redaction/control-sequence policies.

## Delivery Order

1. Workspace trust and executable-surface review.
2. Credential origin binding and project secret restrictions.
3. Structured sandbox execution and enforceable filesystem/network policy.
4. Unified nested execution through the normal tool pipeline.
5. Supply-chain pinning, secret/dependency scanning, and release provenance.

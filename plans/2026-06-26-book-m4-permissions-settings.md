# M4 — Permissions & Layered Settings

**Date:** 2026-06-26  
**Status:** Plan  
**Depends on:** M1 ✅, M2 ✅, M3 ✅  
**Preceded by:** `plans/2026-06-26-book-m1-foundation-hardening.md`, `plans/2026-06-26-book-m3-headless-sessions.md`

## Scope

Implement Claude Code's layered `settings.json` system, tool-specific permission rule syntax
(`Tool(specifier)`), and bash sandbox — the three pillars that let teams govern agent behavior at
the user/project/local/managed scope, with glob-based rule matching and sandbox-enforced
filesystem/network isolation for shell commands.

## Design decisions

### 1. Settings file locations (match CC conventions)

| Scope  | Path                                        | Git |
|--------|---------------------------------------------|-----|
| User   | `~/.book/settings.json`                     | no  |
| Project| `<workspace>/.book/settings.json`            | yes |
| Local  | `<workspace>/.book/settings.local.json`      | no  |

Priority: Local > Project > User. Scalar keys override; arrays merge (permission rules
concatenate). Managed scope deferred to M8 (Agent SDK / enterprise).

**Migration:** Phase out `~/.bookrc.json` (project root, non-CC format invented in v0.1.0).
Keep reading it as fallback in v0.1.x, emit deprecation warning. The new `.book/settings.json`
is the authoritative source.

### 2. Permission rules move into settings.json as `permissions.allow/ask/deny` arrays

**Removed:** The standalone `~/.book/permissions.json` file (40 loc) and its
`PermissionStore` (130 loc). Permission rules live in `settings.json` under the
`permissions` key, exactly matching CC's schema. The existing `PermissionStore` class
is refactored into a stateless evaluator that reads the resolved settings object.

### 3. Bash sandbox

On macOS/Linux/WSL2: use bubblewrap (`bwrap`) for filesystem + network isolation.
On native Windows: warn that sandbox is unavailable, keep running unsandboxed.

## Phases & Tasks

### Phase 1 — Settings schema & loader (4 tasks)

- [ ] **T1.1** Define `BookSettings` type (Zod schema) with all M4 keys:
  `permissions`, `sandbox`, `model`, `maxTurns`, `maxTokens`, `autoCompactEnabled`,
  `defaultMode`, `disableBypassPermissionsMode`, `additionalDirectories`, `env`
- [ ] **T1.2** Implement `resolveSettings(workspace)` — layered loader:
  `~/.book/settings.json` → `.book/settings.json` → `.book/settings.local.json`
  with deep-merge (scalar override, array concat for permissions + additionalDirectories)
- [ ] **T1.3** Wire settings into `AgentConfig` — extend config with resolved `permissions`
  and `sandbox`. Deprecate `loadConfig()` reading `~/.bookrc.json` (keep as fallback).
- [ ] **T1.4** Schema validation on load — reject malformed files with clear error messages;
  refuse to start if any layer fails parsing (except missing = ok). Jest-style test table.

### Phase 2 — Tool(specifier) rule evaluator (3 tasks)

- [ ] **T2.1** Parse `Tool(specifier)` strings into `{toolName, pattern}` — glob
  (`*`, `**`) in the parenthesized pattern. Empty parens means match-all for that tool.
  Just `Tool` means the tool with any arguments.
- [ ] **T2.2** Implement `evaluatePermission(call, rules)` — evaluate deny→ask→allow
  order, first match wins. Rules from all scopes merged (managed defer). Integrate
  with `primaryArgForRule()` already in `loop.ts`.
- [ ] **T2.3** Integrate into agent loop — replace the `needsPermission()` + `PermissionStore`
  calls in `loop.ts` and `headless.ts` with the new evaluator reading resolved rules
  from config. The `permissionStore.evaluate()` codepath is removed.

### Phase 3 — Bash sandbox (3 tasks)

- [ ] **T3.1** Implement `createSandbox(config)` — detect bwrap presence,
  build command wrapper for filesystem + network isolation from sandbox settings.
  Return a `{wrap(cmd): string}` or null if unavailable.
- [ ] **T3.2** Integrate sandbox into `Bash` tool — wrap commands through the sandbox
  when `sandbox.enabled` is true. Auto-approve when `sandbox.autoAllowBashIfSandboxed`.
  Honor `sandbox.excludedCommands` (skip sandbox for `docker *`, etc.).
- [ ] **T3.3** Windows graceful degradation — detect platform, warn on startup if
  sandbox is unavailable, run unsandboxed (unless `failIfUnavailable`).

### Phase 4 — Wiring & cleanup (3 tasks)

- [ ] **T4.1** Remove `PermissionStore` class and `~/.book/permissions.json`.
  Migrate existing persisted rules into `.book/settings.local.json` on first load.
- [ ] **T4.2** Add `--settings <path>` CLI flag for ad-hoc settings override
  (matching CC's `--settings` flag).
- [ ] **T4.3** End-to-end verification: write test settings.json with deny/allow rules,
  run headless mode, confirm tools are granted/blocked per the rules, sandbox wraps bash,
  and settings merge correctly across scopes.

## Out of scope (deferred to later milestones)

- Managed scope (enterprise policy) → M8 Agent SDK
- `ConfigChange` hook / live settings reload → M5 Hooks
- `strictPluginOnlyCustomization` / plugin locking → M8
- `allowedHttpHookUrls` / `httpHookAllowedEnvVars` → M5
- `forceLoginMethod` / `forceLoginOrgUUID` → M8
- `footerLinksRegexes` / `pluginSuggestionMarketplaces` → M8
- `sandbox.credentials.*` (v2.1.187+) → skip (too new, Windows-first context)

## Verification gate

1. `book -p "read .env"` with a `deny: ["Read(./.env)"]` rule → tool blocked
2. `book -p "git diff"` with an `allow: ["Bash(git *)"]` rule → auto-approved
3. `book -p "ls"` with `sandbox.enabled: true` → bash runs wrapped in bwrap
4. User settings at `~/.book/settings.json` override defaults, project overrides user,
   local overrides project
5. Malformed settings.json → clear error message, no partial load
6. Existing `.bookrc.json` still works (deprecation warning only, no hard break)

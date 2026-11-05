/**
 * Trust decisions for hook entries declared by a repository.
 *
 * A hook entry is a shell command the repository can get Book to execute at any
 * lifecycle event — on every prompt, around every tool call, at session start.
 * Once merged into resolved settings an entry carries no provenance, so nothing
 * downstream can tell a repository's hook from the user's own.
 *
 * Project-declared hooks therefore require a one-time per-workspace decision,
 * keyed by a fingerprint of the full entry (event, matcher, command, env) and
 * recorded in the user-global trust store, outside the workspace, where nothing
 * the repository ships can reach it (see `workspace-trust.ts`). Any change to
 * an entry produces a new fingerprint and reverts it to untrusted.
 *
 * User-global and local-layer hooks need no gate: those layers were written by
 * or for the user.
 */
import { createHash } from 'crypto';
import { CONTROL_CHARACTERS } from './control-characters.js';
import { HOOK_EVENTS, type HookEntry, type HookEvent, type ProjectHookChoice } from './settings.js';
import { updateWorkspaceTrust } from './workspace-trust.js';

/** Every project-declared hook entry, paired with the event that triggers it. */
export interface DeclaredHook {
  event: HookEvent;
  entry: HookEntry;
}

/** Stable digest of everything the user is asked to trust about a hook. */
export function hookFingerprint(event: HookEvent, entry: HookEntry): string {
  const sortedEnv = Object.fromEntries(
    Object.entries(entry.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  const canonical = JSON.stringify({
    event,
    matcher: entry.matcher ?? null,
    command: entry.command,
    env: sortedEnv,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Flatten a settings document into its declared hook entries, event paired. */
export function collectDeclaredHooks(
  settings:
    | {
        hooks?: Partial<Record<HookEvent, HookEntry[]>> & { projectEntries?: unknown };
      }
    | null
    | undefined,
): DeclaredHook[] {
  const declared: DeclaredHook[] = [];
  for (const event of HOOK_EVENTS) {
    for (const entry of settings?.hooks?.[event] ?? []) {
      declared.push({ event, entry });
    }
  }
  return declared;
}

export type ProjectHookState = ProjectHookChoice | 'unknown';

export function evaluateProjectHook(
  store: Record<string, ProjectHookChoice> | undefined,
  fingerprint: string,
): ProjectHookState {
  return store?.[fingerprint] ?? 'unknown';
}

export interface ProjectHookPartition {
  /** Approved by the user: these join the resolved hooks. */
  approved: DeclaredHook[];
  /** No decision recorded: withheld until the user makes one. */
  pending: DeclaredHook[];
  /** Explicitly refused: withheld, and not re-offered. */
  rejected: DeclaredHook[];
}

export function partitionProjectHooks(
  hooks: readonly DeclaredHook[],
  store: Record<string, ProjectHookChoice> | undefined,
): ProjectHookPartition {
  const partition: ProjectHookPartition = { approved: [], pending: [], rejected: [] };
  for (const hook of hooks) {
    const state = evaluateProjectHook(store, hookFingerprint(hook.event, hook.entry));
    if (state === 'approved') partition.approved.push(hook);
    else if (state === 'rejected') partition.rejected.push(hook);
    else partition.pending.push(hook);
  }
  return partition;
}

/** One control character as text a reader can see: a mnemonic, `\xNN` for C0 and C1, or `\uNNNN`. */
function visibleEscape(character: string): string {
  if (character === '\n') return '\\n';
  if (character === '\r') return '\\r';
  if (character === '\t') return '\\t';
  const hex = character.charCodeAt(0).toString(16);
  return hex.length <= 2 ? `\\x${hex.padStart(2, '0')}` : `\\u${hex.padStart(4, '0')}`;
}

/**
 * Render repository-authored text for a terminal that is about to ask the user
 * to trust it.
 *
 * A hook command and its environment values are written by the party being
 * gated. Printed raw, a value carrying newlines or ANSI escapes can forge
 * further lines of the report — including an `[x] …` line for a hook that is
 * nothing of the kind — and a bidi override or a line separator can make the
 * line read as something it does not say. Every character of
 * {@link CONTROL_CHARACTERS} becomes a visible escape, and an over-long value
 * is truncated so one entry cannot push the rest of the disclosure off screen.
 *
 * The limit counts the escaped length. The walk is by code point and an escape
 * goes in whole or not at all, so the cut never leaves half of one, or half of
 * a surrogate pair: a backslash the value itself holds is kept, so half an
 * escape could not be told from text and removed afterwards.
 */
export function renderUntrustedText(value: string, maxLength = 200): string {
  let rendered = '';
  for (const character of value) {
    const shown = character.replace(CONTROL_CHARACTERS, visibleEscape);
    if (rendered.length + shown.length > maxLength) return `${rendered}…`;
    rendered += shown;
  }
  return rendered;
}

/**
 * Everything the fingerprint covers, rendered for a trust decision.
 *
 * The fingerprint digests event, matcher, command *and* env, so a disclosure
 * showing only the command understates what approval grants: `npm test` with
 * `NODE_OPTIONS=--require ./payload.js` reads as harmless and is not. Two
 * entries differing only in matcher or env are also indistinguishable without
 * these lines.
 */
export function describeDeclaredHook(hook: DeclaredHook): { headline: string; details: string[] } {
  const details = [`fingerprint: ${hookFingerprint(hook.event, hook.entry)}`];
  if (hook.entry.matcher !== undefined) {
    details.push(`matcher:     ${renderUntrustedText(hook.entry.matcher)}`);
  }
  for (const [key, value] of Object.entries(hook.entry.env ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    details.push(`env:         ${renderUntrustedText(key, 64)}=${renderUntrustedText(value)}`);
  }
  return { headline: `${hook.event}: ${renderUntrustedText(hook.entry.command)}`, details };
}

/**
 * Record an approve/reject decision for one hook, leaving every other recorded
 * decision — in this workspace and in every other — untouched.
 */
export function persistProjectHookChoice(
  workspace: string,
  fingerprint: string,
  choice: ProjectHookChoice,
  options: { trustStorePath?: string } = {},
): { ok: boolean; error?: string } {
  return updateWorkspaceTrust(
    workspace,
    (trust) => {
      trust.hookEntries[fingerprint] = choice;
    },
    options.trustStorePath,
  );
}

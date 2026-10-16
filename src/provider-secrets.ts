/**
 * The agent's own provider credentials, kept out of tool output (#411).
 *
 * Book hands every Bash child its environment (`BOOK_HOME`, `BOOK_API_KEY`), so a command that
 * prints `$BOOK_API_KEY` or `$BOOK_HOME/settings.json` would otherwise carry the key to the model
 * provider, the session JSONL and `<BOOK_HOME>/tool-output/`. The agent loop redacts each result
 * once, as it is finalized, with the helpers here. Matching is by exact value only: no heuristics,
 * and no pattern is built from a key.
 *
 * Deliberately stateless (no cache): `collectProviderSecrets` reads the config and the environment
 * afresh each time it is called. The agent loop calls it once per `runAgentLoop` and shares the
 * result through `ToolContext.providerSecrets`, so every result of a run is redacted with the same
 * set, and a `/model` switch or an edited key file takes effect on the next run.
 */
import { isWithheldWorkspaceProvider, resolveSecret } from './config.js';
import type { AgentConfig } from './types/runtime.js';
import type { ToolResult } from './types/tools.js';

/** What replaces a provider secret. Fixed, and made of no key's characters. */
export const PROVIDER_KEY_MARKER = '[redacted: provider key]';

/**
 * A value shorter than this is not treated as a secret: replacing a 3-letter "key" everywhere
 * would mangle ordinary output for no protection.
 */
export const MIN_PROVIDER_SECRET_LENGTH = 8;

/**
 * Well-known dummy keys that keyless local endpoints (LM Studio, llama.cpp, Ollama-style servers)
 * ask for. They are ordinary strings, not credentials: treating one as a secret would erase every
 * mention of `lm-studio` from all tool output and make an Edit `old_string` that names it stop
 * matching. Compared case-insensitively, after trimming.
 */
export const PLACEHOLDER_PROVIDER_KEYS: readonly string[] = [
  'not-needed',
  'lm-studio',
  'sk-no-key-required',
  'no-key-required',
  'no-api-key',
  'dummy-key',
  'placeholder',
];

/**
 * The secret values to redact, longest first and without duplicates.
 *
 * A provider the workspace declared and the user has not approved is skipped: its `apiKey` is
 * repository-controlled, and honouring it would let a repository erase a chosen word from every
 * tool output, or make Book read a `file:` path the repository picked.
 *
 * The `isWithheldWorkspaceProvider` check below is defense in depth: the settings loader already
 * leaves a withheld provider out of `settings.provider`, so this loop never normally meets one.
 */
export function collectProviderSecrets(config: AgentConfig): string[] {
  const candidates: Array<string | undefined> = [config.apiKey, process.env.BOOK_API_KEY];
  for (const [id, provider] of Object.entries(config.settings.provider ?? {})) {
    if (isWithheldWorkspaceProvider(config, id)) continue;
    candidates.push(resolveSecret(provider.apiKey, config.workspace));
  }
  const secrets = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (value.length < MIN_PROVIDER_SECRET_LENGTH) continue;
    if (PLACEHOLDER_PROVIDER_KEYS.includes(value.toLowerCase())) continue;
    secrets.add(value);
  }
  return [...secrets].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Replace every occurrence of every secret with {@link PROVIDER_KEY_MARKER}. Overlapping
 * occurrences collapse into one marker, so a key that contains (or overlaps) another is replaced
 * whole, and the marker is never rescanned.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  if (!text || secrets.length === 0) return text;
  const spans: Array<[number, number]> = [];
  for (const secret of secrets) {
    if (!secret) continue;
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      spans.push([at, at + secret.length]);
    }
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let cursor = 0;
  let [start, end] = spans[0];
  const flush = (): void => {
    out += text.slice(cursor, start) + PROVIDER_KEY_MARKER;
    cursor = end;
  };
  for (const span of spans.slice(1)) {
    if (span[0] < end) {
      end = Math.max(end, span[1]);
      continue;
    }
    flush();
    [start, end] = span;
  }
  flush();
  return out + text.slice(cursor);
}

/**
 * Where a chunk of `text` may end so that no secret straddles the cut.
 *
 * A `BashOutput` read of `limit` characters can end inside a key, and neither half then matches
 * exactly, so each would reach the model unredacted. A cut inside an occurrence moves back to where
 * the occurrence starts; when that leaves nothing (the occurrence opens the chunk), it moves forward
 * to where the occurrence ends instead. Matching stays exact, so the central redactor then replaces
 * the whole key. Returns `limit` itself when the cut is clean, and never more than `text.length`.
 */
export function secretSafeCut(text: string, limit: number, secrets: readonly string[]): number {
  const wanted = Math.min(Math.max(1, limit), text.length);
  if (wanted >= text.length || secrets.length === 0) return wanted;

  /** The occurrences that cover the boundary before `cut`: they start before it and end past it. */
  const spanning = (cut: number): Array<[number, number]> => {
    const found: Array<[number, number]> = [];
    for (const secret of secrets) {
      if (!secret) continue;
      const from = Math.max(0, cut - secret.length + 1);
      for (let at = text.indexOf(secret, from); at !== -1 && at < cut;) {
        found.push([at, at + secret.length]);
        at = text.indexOf(secret, at + 1);
      }
    }
    return found;
  };

  let back = wanted;
  for (let spans = spanning(back); spans.length > 0; spans = spanning(back)) {
    back = Math.min(...spans.map(([start]) => start));
  }
  if (back > 0) return back;

  let forward = wanted;
  for (let spans = spanning(forward); spans.length > 0; spans = spanning(forward)) {
    forward = Math.max(...spans.map(([, end]) => end));
  }
  return forward;
}

/**
 * Where a window of `text` may start so that no secret is cut by its front edge: the mirror of
 * {@link secretSafeCut}. A start inside an occurrence moves back to where the occurrence starts, so
 * the whole key stays in the window and the redactor replaces it; otherwise the fragment that
 * remained would match nothing.
 */
export function secretSafeStart(text: string, start: number, secrets: readonly string[]): number {
  let safe = Math.min(Math.max(0, start), text.length);
  if (safe === 0 || safe >= text.length || secrets.length === 0) return safe;
  for (;;) {
    let earliest = safe;
    for (const secret of secrets) {
      if (!secret) continue;
      const from = Math.max(0, safe - secret.length + 1);
      for (let at = text.indexOf(secret, from); at !== -1 && at < safe;) {
        earliest = Math.min(earliest, at);
        at = text.indexOf(secret, at + 1);
      }
    }
    if (earliest === safe) return safe;
    safe = earliest;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Redact every string inside a plain object/array tree; the same value back when none matched. */
function redactValue(value: unknown, secrets: readonly string[], ancestors: Set<object>): unknown {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (typeof value !== 'object' || value === null) return value;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return value;
  if (ancestors.has(value)) return value;
  ancestors.add(value);
  try {
    if (isArray) {
      let copy: unknown[] | undefined;
      value.forEach((item, index) => {
        const next = redactValue(item, secrets, ancestors);
        if (next === item) return;
        copy ??= [...value];
        copy[index] = next;
      });
      return copy ?? value;
    }
    const record = value as Record<string, unknown>;
    let copy: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(record)) {
      const next = redactValue(item, secrets, ancestors);
      if (next === item) continue;
      copy ??= { ...record };
      copy[key] = next;
    }
    return copy ?? value;
  } finally {
    ancestors.delete(value);
  }
}

/** Fields that identify the call rather than carry output; never rewritten. */
const IDENTITY_FIELDS = new Set(['version', 'toolCallId', 'status']);

/**
 * A copy of `result` with the secrets removed from every string it carries: `content`, the
 * presentation, the structured error, the masked placeholder, artifacts, and strings anywhere in
 * `data`. The same object when nothing matched.
 */
export function redactToolResultSecrets<T extends ToolResult>(
  result: T,
  secrets: readonly string[],
): T {
  if (secrets.length === 0) return result;
  const ancestors = new Set<object>();
  let copy: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(result)) {
    if (IDENTITY_FIELDS.has(key)) continue;
    const next = redactValue(value, secrets, ancestors);
    if (next === value) continue;
    copy ??= { ...(result as Record<string, unknown>) };
    copy[key] = next;
  }
  return (copy as T | undefined) ?? result;
}

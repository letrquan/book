/**
 * Persist settings to the project-local layer (.book/settings.local.json).
 *
 * Mirrors the write path of cli/config-cmd.ts but is safe to call from inside
 * the Ink TUI: it returns {ok, error?} instead of calling console.log /
 * process.exit() (which would kill the app). Settings are layered user →
 * project → local; we write to the local (highest-priority, gitignored) layer.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { setNestedValue } from '../cli/utils.js';

const LOCAL_DIR = '.book';
const LOCAL_FILE = 'settings.local.json';

/** Read the local settings.local.json as a plain object ({} if absent/invalid). */
export function readSettingsLocal(workspace: string): Record<string, unknown> {
  const localPath = join(workspace, LOCAL_DIR, LOCAL_FILE);
  if (!existsSync(localPath)) return {};
  try {
    const raw = readFileSync(localPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Set a single dot-path key in the local settings layer and persist it.
 * Returns {ok:false, error} on a filesystem or write failure (never throws).
 * `value` is stored verbatim (string) — number/bool/object callers should
 * pre-serialize, but a non-string is also stored as-is.
 */
export function persistSettingsLocal(
  workspace: string,
  values: Record<string, unknown>,
): { ok: boolean; error?: string } {
  try {
    const localDir = join(workspace, LOCAL_DIR);
    const localPath = join(localDir, LOCAL_FILE);
    mkdirSync(localDir, { recursive: true });
    const existing = readSettingsLocal(workspace);
    for (const [key, value] of Object.entries(values)) setNestedValue(existing, key, value);
    writeFileSync(localPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function persistSettingLocal(
  workspace: string,
  key: string,
  value: unknown,
): { ok: boolean; error?: string } {
  return persistSettingsLocal(workspace, { [key]: value });
}

/**
 * Append a permission rule to settings.permissions.<list> in the local layer.
 * Dedupes exact-string matches. Used by the "Always allow" approval flow
 * (the Claude-Code-aligned way rules get added, rather than a /permissions
 * string parser).
 */
export function persistPermissionRuleLocal(
  workspace: string,
  list: 'allow' | 'ask' | 'deny',
  rule: string,
): { ok: boolean; error?: string } {
  const existing = readSettingsLocal(workspace);
  const perms = (existing.permissions ?? {}) as Record<string, unknown[]>;
  const arr = Array.isArray(perms[list]) ? [...(perms[list] as unknown[])] : [];
  if (!arr.includes(rule)) arr.push(rule);
  perms[list] = arr;
  return persistSettingLocal(workspace, 'permissions', perms);
}

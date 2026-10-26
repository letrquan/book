/**
 * Settings that used to exist and no longer do.
 *
 * Removing a feature leaves its configuration behind on real machines, and zod
 * strips unknown keys silently — so a user who configured a removed capability
 * gets no signal at all that their setting stopped being read. Worse, a removed
 * *value* of a surviving key (`compactStrategy: "zero-mem"`) fails the schema
 * and takes the whole document down with a raw validator dump naming no remedy.
 *
 * This module is the one place that knows what was removed, so both failure
 * modes become a sentence that names the feature, the file, and the edit to
 * make. Notices are advisory: a stale key must not brick a working install, so
 * nothing here throws. `book doctor` prints them, and the credential error
 * consults them when the removed block was the user's only credential.
 */

import { existsSync, readFileSync } from 'node:fs';

/** A removed setting found in a document, and what to tell the user about it. */
export interface RemovedSettingNotice {
  /** Dotted path of the offending key, e.g. `auth` or `compactStrategy`. */
  key: string;
  message: string;
}

/** Removed top-level settings blocks, with the guidance for each. */
const REMOVED_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  [
    'auth',
    'The 0.3 subscription profiles were removed, and the "auth" block is no longer read. ' +
      'Delete it, and set BOOK_API_KEY or provider.<id>.apiKey instead (or, for a ChatGPT plan, ' +
      'the experimental `book auth login`, which keeps its sign-in elsewhere).',
  ],
  [
    'harness',
    'The adaptive harness was removed. Delete the "harness" block; it is no longer read.',
  ],
  [
    'experimental',
    'The experimental Zero-Mem capability was removed and with it the "experimental" block. ' +
      'Delete it; compaction is always the production summary strategy now.',
  ],
];

/**
 * Removed keys inside a surviving block, by their path below the document root. The auto-memory
 * rework removed the approval inbox, the external-content quarantine and post-session extraction,
 * so the three settings that tuned them are no longer read.
 */
const REMOVED_NESTED: ReadonlyArray<readonly [readonly string[], string]> = [
  [
    ['memory', 'requireApproval'],
    'The memory inbox was removed: the model writes memory files directly. Delete memory.requireApproval; ' +
      'set memory.autoSave to false to make memory read-only.',
  ],
  [
    ['memory', 'quarantineExternal'],
    'The external-content quarantine was removed: a session that read the web or an MCP server writes memory ' +
      'like any other. Delete memory.quarantineExternal.',
  ],
  [
    ['memory', 'extraction'],
    'Post-session memory extraction was removed. Delete the memory.extraction block; it is no longer read.',
  ],
];

/** The permission rule lists whose entries can name a tool that no longer exists. */
const PERMISSION_RULE_LISTS = ['allow', 'ask', 'deny'] as const;

/** A permission rule that names the removed `MemorySave` tool: bare, or with a pattern. */
function namesMemorySave(rule: unknown): rule is string {
  return typeof rule === 'string' && /^\s*MemorySave\s*(\(|$)/.test(rule);
}

/**
 * The credential file the 0.3 `book auth login` wrote, which nothing reads any more. Sign in with
 * ChatGPT keeps its record in `chatgpt-signin.json` (`src/auth/chatgpt-store.ts`), never here.
 */
export const REMOVED_AUTH_STORE_FILENAME = 'auth.json';

/**
 * Guidance for the orphaned credential store. The file is deliberately not
 * deleted for the user: it is theirs, it is mode 0600, and a tool that removes
 * credentials without being asked is worse than one that reports them.
 */
export function removedAuthStoreNotice(path: string): string {
  return (
    `${path} holds an OAuth refresh token from the 0.3 subscription login, which was removed. ` +
    'Nothing reads it any more — delete the file, and revoke the token with the provider ' +
    'if it was ever used.'
  );
}

/** Environment variables that no longer do anything, with their guidance. */
const REMOVED_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  ['BOOK_AUTH_PROFILE', 'The 0.3 subscription profiles were removed; use BOOK_API_KEY.'],
  ['BOOK_AUTH_CLIENT_ID', 'The 0.3 subscription profiles were removed; use BOOK_API_KEY.'],
  ['BOOK_AUTH_CLIENT_SECRET', 'The 0.3 subscription profiles were removed; use BOOK_API_KEY.'],
  ['BOOK_EXPERIMENTAL_ZERO_MEM', 'Zero-Mem was removed; summary compaction is the only strategy.'],
  ['BOOK_ZERO_MEM_MODEL_CACHE', 'Zero-Mem was removed.'],
  ['BOOK_ZERO_MEM_LOCAL_FILES_ONLY', 'Zero-Mem was removed.'],
  [
    'BOOK_COMPACT_STRATEGY',
    'Compaction strategy is no longer selectable; summary is the only one.',
  ],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a settings file for inspection, or undefined if it is missing or unreadable. */
export function readSettingsDocumentForNotices(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // A malformed file is a different problem, reported by the loader.
    return undefined;
  }
}

/**
 * Did this machine carry subscription-auth configuration that is no longer read?
 *
 * Consulted only on the "no credential" error path, so the file reads cost
 * nothing in the normal case.
 */
export function hadRemovedAuthConfiguration(
  settingsFilePaths: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (Object.keys(env).some((key) => key.startsWith('BOOK_AUTH_'))) return true;
  return settingsFilePaths.some((path) => {
    const document = readSettingsDocumentForNotices(path);
    return isRecord(document) && document.auth !== undefined;
  });
}

/**
 * Removed settings present in one parsed settings document.
 *
 * Takes the *raw* parsed JSON rather than a validated document, because the
 * whole point is to see the keys validation is about to discard.
 */
export function collectRemovedSettingNotices(document: unknown): RemovedSettingNotice[] {
  if (!isRecord(document)) return [];
  const notices: RemovedSettingNotice[] = [];
  for (const [key, message] of REMOVED_BLOCKS) {
    if (document[key] !== undefined) notices.push({ key, message });
  }
  for (const [path, message] of REMOVED_NESTED) {
    let node: unknown = document;
    for (const segment of path) node = isRecord(node) ? node[segment] : undefined;
    if (node !== undefined) notices.push({ key: path.join('.'), message });
  }
  const permissions = document.permissions;
  if (isRecord(permissions)) {
    for (const list of PERMISSION_RULE_LISTS) {
      const rules = permissions[list];
      if (!Array.isArray(rules)) continue;
      for (const rule of rules.filter(namesMemorySave)) {
        notices.push({
          key: `permissions.${list}`,
          message:
            `The rule ${JSON.stringify(rule)} names MemorySave, which was removed: the model writes memory with ` +
            'Write, Edit and ApplyPatch now, so it matches nothing. To restrict memory writes, ' +
            'write a rule on those tools for the memory directory, or set memory.autoSave to false.',
        });
      }
    }
  }
  // A removed *value* of a surviving key. `compactStrategy` still exists and is
  // now `"summary"` only, so the old Zero-Mem selector has to be named
  // explicitly or the user is left reading a schema error about a literal type.
  if (document.compactStrategy !== undefined && document.compactStrategy !== 'summary') {
    notices.push({
      key: 'compactStrategy',
      message:
        `compactStrategy: ${JSON.stringify(document.compactStrategy)} is no longer a choice. ` +
        'Zero-Mem was removed and summary compaction is the only strategy; delete the key.',
    });
  }
  return notices;
}

/** Removed environment variables that are set in `env`, with their guidance. */
export function collectRemovedEnvNotices(env: NodeJS.ProcessEnv): RemovedSettingNotice[] {
  const notices: RemovedSettingNotice[] = [];
  for (const [name, message] of REMOVED_ENV_VARS) {
    // The client-id variables are per-profile suffixed, so match by prefix.
    const matches =
      name.endsWith('CLIENT_ID') || name.endsWith('CLIENT_SECRET')
        ? Object.keys(env).filter((key) => key.startsWith(`${name}_`) || key === name)
        : env[name] !== undefined
          ? [name]
          : [];
    for (const key of matches) notices.push({ key, message });
  }
  return notices;
}

/**
 * Drop removed keys and coerce removed values so a stale document still loads.
 *
 * Unknown blocks are stripped by validation anyway; the value coercion is the
 * part that matters, because without it one obsolete string fails the whole
 * file and Book will not start. Returns a copy — the caller's document is left
 * alone so it can still be reported on.
 */
export function normalizeRemovedSettings(document: unknown): unknown {
  if (!isRecord(document)) return document;
  if (document.compactStrategy === undefined || document.compactStrategy === 'summary') {
    return document;
  }
  const normalized = { ...document };
  delete normalized.compactStrategy;
  return normalized;
}

/**
 * Trust decisions the user makes about repository-controlled input.
 *
 * Book gates three kinds of repository-declared configuration behind a one-time
 * per-workspace decision: `permissions.allow` rules, MCP servers, and hook
 * entries. Each gate is only as strong as the store its decisions live in.
 *
 * That store used to be `<workspace>/.book/settings.local.json`, on the
 * reasoning that the file is gitignored and only Book writes it. `.gitignore`
 * does not stop a *tracked* file from reaching a clone: `git add -f
 * .book/settings.local.json` ships it with the repository, and every
 * fingerprint the store is keyed by is a digest of configuration the repository
 * already controls. A hostile project could therefore precompute its own
 * approvals and arrive pre-trusted, releasing its hooks on first run.
 *
 * Approval data lives outside the workspace instead, in
 * `<BOOK_HOME>/trust.json`, keyed by absolute workspace path. Nothing a
 * repository can write reaches it, so the gated party cannot self-approve
 * whatever it does to the files it ships.
 *
 * Reads are fail-closed: an unparseable or off-schema store resolves to "no
 * decisions recorded", which withholds the gated input rather than releasing
 * it. Writes refuse to touch a store they could not parse, so a corrupt or
 * newer-versioned file is reported rather than silently overwritten.
 */
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { resolveBookHome } from './book-home.js';
import { writeFileAtomic } from './settings-repository.js';
import {
  mcpProjectServerChoiceSchema,
  projectAllowRuleChoiceSchema,
  projectHookChoiceSchema,
} from './settings.js';

/** Bumped only for a format change that older Book versions cannot read. */
export const TRUST_STORE_VERSION = 1;

const workspaceTrustSchema = z.object({
  /** Keyed by the exact rule text the project layer declared. */
  permissionAllowRules: z.record(projectAllowRuleChoiceSchema).default({}),
  /** Keyed by server name, carrying the fingerprint the decision was made against. */
  mcpServers: z.record(mcpProjectServerChoiceSchema).default({}),
  /** Keyed by a fingerprint of `{ event, matcher, command, env }`. */
  hookEntries: z.record(projectHookChoiceSchema).default({}),
});

export type WorkspaceTrust = z.infer<typeof workspaceTrustSchema>;

export function emptyWorkspaceTrust(): WorkspaceTrust {
  return { permissionAllowRules: {}, mcpServers: {}, hookEntries: {} };
}

/** Location of the user-global trust store. */
export function defaultTrustStorePath(home?: string): string {
  return home ? join(home, '.book', 'trust.json') : join(resolveBookHome(), 'trust.json');
}

function workspaceKey(workspace: string): string {
  const absolute = resolve(workspace);
  // Windows paths are case-insensitive: without folding, `D:\repo` and `d:\repo`
  // would accumulate two independent sets of decisions for one directory, and a
  // decision recorded under one spelling would read back as "not decided".
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

interface RawTrustStore {
  /** Other workspaces' entries, preserved verbatim so a write never drops them. */
  workspaces: Record<string, unknown>;
}

interface RawTrustStoreRead {
  store: RawTrustStore;
  /** Set when the file exists but could not be understood; blocks writes. */
  unreadable?: string;
}

function readRawStore(path: string): RawTrustStoreRead {
  if (!existsSync(path)) return { store: { workspaces: {} } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    return {
      store: { workspaces: {} },
      unreadable: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { store: { workspaces: {} }, unreadable: `${path} must contain a JSON object` };
  }

  const record = parsed as Record<string, unknown>;
  const version = typeof record.version === 'number' ? record.version : TRUST_STORE_VERSION;
  if (version > TRUST_STORE_VERSION) {
    return {
      store: { workspaces: {} },
      unreadable: `${path} was written by a newer version of Book (trust store v${version}); upgrade before recording new decisions`,
    };
  }

  const workspaces = record.workspaces;
  if (workspaces === undefined) return { store: { workspaces: {} } };
  if (workspaces === null || typeof workspaces !== 'object' || Array.isArray(workspaces)) {
    return { store: { workspaces: {} }, unreadable: `${path} "workspaces" must be an object` };
  }
  return { store: { workspaces: { ...(workspaces as Record<string, unknown>) } } };
}

/**
 * Decisions recorded for one workspace. Anything unreadable resolves to no
 * decisions, which withholds the gated input.
 */
export function loadWorkspaceTrust(
  workspace: string,
  storePath: string = defaultTrustStorePath(),
): WorkspaceTrust {
  const { store } = readRawStore(storePath);
  const parsed = workspaceTrustSchema.safeParse(store.workspaces[workspaceKey(workspace)] ?? {});
  return parsed.success ? parsed.data : emptyWorkspaceTrust();
}

/**
 * Apply a decision to one workspace's record, leaving every other workspace's
 * entry byte-identical.
 */
export function updateWorkspaceTrust(
  workspace: string,
  mutate: (trust: WorkspaceTrust) => void,
  storePath: string = defaultTrustStorePath(),
): { ok: boolean; error?: string } {
  const { store, unreadable } = readRawStore(storePath);
  if (unreadable) return { ok: false, error: unreadable };

  const key = workspaceKey(workspace);
  const existing = workspaceTrustSchema.safeParse(store.workspaces[key] ?? {});
  const candidate = existing.success ? existing.data : emptyWorkspaceTrust();
  mutate(candidate);

  const validated = workspaceTrustSchema.safeParse(candidate);
  if (!validated.success) return { ok: false, error: validated.error.message };

  const next = {
    version: TRUST_STORE_VERSION,
    workspaces: { ...store.workspaces, [key]: validated.data },
  };
  try {
    writeFileAtomic(storePath, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}

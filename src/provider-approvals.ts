/**
 * Trust decisions for providers a workspace layer declares.
 *
 * A provider entry names two things the user cares about: where a request goes (`baseURL`) and
 * which credential rides along (`apiKey`, a literal or a `{file:…}` / `{env:…}` reference that
 * Book reads on the entry's behalf). A checked-in `.book/settings.json`, a force-added
 * `.book/settings.local.json` or a legacy `.bookrc.json` can write both, so honouring them
 * unchecked lets a repository send the user's provider key, any `~/` file or any environment
 * variable to an origin the repository names.
 *
 * Two rules close that, in the shapes the other repository-input gates already use:
 *
 * - A provider id a **trusted** layer (the user file, a `--settings` file) defines keeps the
 *   trusted layer's origin and key. A workspace layer's `baseURL`, `baseUrl` and `apiKey` for that
 *   id are dropped before merging; its `models` and `type` entries still merge.
 * - A provider id **only workspace layers define** is held back until the user approves it in the
 *   user-global trust store (`workspace-trust.ts`), against a fingerprint of its declared type,
 *   origin and key reference. Changing any of those re-withholds it. An approved one is merged in,
 *   but it never inherits a key: only its own `apiKey` is sent (see `resolveModelProviderConfig`).
 *
 * Everything here is pure except {@link persistWorkspaceProviderChoice}: the loader and the
 * reporting hosts call the same functions, so what is enforced and what is reported cannot drift.
 */
import { createHash } from 'crypto';
import type { ProviderConfig, WorkspaceProviderChoice } from './settings.js';
import { renderUntrustedText } from './hook-approvals.js';
import { updateWorkspaceTrust } from './workspace-trust.js';

/** A provider entry as a settings file wrote it: every key optional, nothing defaulted. */
export type ProviderDeclaration = Partial<ProviderConfig>;

/** One settings layer's `provider` map. */
export type ProviderMap = Readonly<Record<string, ProviderDeclaration>>;

/** The decision-store key for a legacy `.bookrc.json` `baseUrl`, which is not a provider. */
export const LEGACY_BASE_URL_ID = '.bookrc.json';

/** The keys of a provider entry that choose where a request goes or which key it carries. */
const OVERRIDE_KEYS = ['baseURL', 'baseUrl', 'apiKey'] as const;

/** `__proto__` parses as an ordinary own key but assigning it would reach the prototype setter. */
function usableId(id: string): boolean {
  return id !== '__proto__';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Digest of everything the user is asked to trust about a workspace-declared provider: the
 * declared `type`, the origin (`baseURL ?? baseUrl`, as written) and the `apiKey` exactly as
 * written. A reference is fingerprinted as text, never resolved, so computing one reads nothing.
 * `models` stays out: a catalog entry sends nothing anywhere.
 */
export function workspaceProviderFingerprint(entry: ProviderDeclaration): string {
  const canonical = JSON.stringify({
    type: entry.type ?? 'openai',
    origin: entry.baseURL ?? entry.baseUrl ?? null,
    apiKey: entry.apiKey ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Fingerprint of a legacy `.bookrc.json` `baseUrl`. */
export function legacyBaseUrlFingerprint(baseUrl: string): string {
  return createHash('sha256').update(JSON.stringify({ baseUrl })).digest('hex').slice(0, 16);
}

export type WorkspaceProviderState = 'approved' | 'rejected' | 'pending';

function evaluateDecision(
  decisions: Readonly<Record<string, WorkspaceProviderChoice>> | undefined,
  id: string,
  fingerprint: string,
): WorkspaceProviderState {
  if (!decisions || !Object.hasOwn(decisions, id)) return 'pending';
  const decision = decisions[id];
  return decision.fingerprint === fingerprint ? decision.choice : 'pending';
}

/**
 * Whether the user approved honouring a legacy `.bookrc.json` `baseUrl`. The file ships with a
 * repository and its `baseUrl` receives `BOOK_API_KEY`, so it is ignored unless approved.
 */
export function evaluateLegacyBaseUrl(
  decisions: Readonly<Record<string, WorkspaceProviderChoice>> | undefined,
  baseUrl: string,
): WorkspaceProviderState {
  return evaluateDecision(decisions, LEGACY_BASE_URL_ID, legacyBaseUrlFingerprint(baseUrl));
}

/** One settings file's provider map, with the path to report it by. */
export interface ProviderLayer {
  path: string;
  providers: ProviderMap | undefined;
}

/** The provider ids the given (trusted) layers define. */
export function providerIdsOf(layers: readonly Pick<ProviderLayer, 'providers'>[]): Set<string> {
  const ids = new Set<string>();
  for (const layer of layers) {
    for (const id of Object.keys(layer.providers ?? {})) if (usableId(id)) ids.add(id);
  }
  return ids;
}

/** Override keys one workspace layer wrote for a provider a trusted layer defines. */
export interface DroppedProviderOverride {
  path: string;
  providerId: string;
  /** Which of `baseURL`, `baseUrl` and `apiKey` the layer wrote. */
  keys: string[];
}

/**
 * The origin and key overrides a workspace layer wrote for a trusted provider. Pure:
 * {@link withoutWorkspaceProviderOverrides} drops exactly these, and a report can list them.
 */
export function droppedProviderOverrides(
  workspaceLayers: readonly ProviderLayer[],
  trustedIds: ReadonlySet<string>,
): DroppedProviderOverride[] {
  const dropped: DroppedProviderOverride[] = [];
  for (const layer of workspaceLayers) {
    for (const [providerId, entry] of Object.entries(layer.providers ?? {})) {
      if (!trustedIds.has(providerId) || !isPlainObject(entry)) continue;
      const keys = OVERRIDE_KEYS.filter((key) => entry[key] !== undefined);
      if (keys.length > 0) dropped.push({ path: layer.path, providerId, keys });
    }
  }
  return dropped;
}

/**
 * A workspace layer's provider map as the merge may see it: only the ids a trusted layer defines,
 * and for those only `models` and `type`. Workspace-only ids are not here — they reach the
 * resolved settings through {@link partitionWorkspaceProviders} or not at all.
 */
export function withoutWorkspaceProviderOverrides(
  providers: ProviderMap,
  trustedIds: ReadonlySet<string>,
): Record<string, ProviderDeclaration> {
  const kept: Record<string, ProviderDeclaration> = {};
  for (const [id, entry] of Object.entries(providers)) {
    if (!trustedIds.has(id) || !usableId(id) || !isPlainObject(entry)) continue;
    const rest: ProviderDeclaration = { ...entry };
    for (const key of OVERRIDE_KEYS) delete rest[key];
    kept[id] = rest;
  }
  return kept;
}

function mergeDeclaration(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || key === '__proto__') continue;
    const existing = result[key];
    result[key] =
      isPlainObject(value) && isPlainObject(existing)
        ? mergeDeclaration(existing, value)
        : structuredClone(value);
  }
  return result;
}

/** A provider only workspace layers declare, merged across them, with what the user decides on. */
export interface WorkspaceProviderEntry {
  id: string;
  /** The merged declaration, later layers over earlier ones. */
  declaration: ProviderDeclaration;
  fingerprint: string;
  /** Every layer that declared it, in merge order. */
  layers: string[];
}

export interface WorkspaceProviderPartition {
  /** The user approved this exact declaration: it joins the resolved providers. */
  approved: WorkspaceProviderEntry[];
  /** No decision recorded for this declaration: withheld until the user makes one. */
  pending: WorkspaceProviderEntry[];
  /** Explicitly refused: withheld, and not re-offered. */
  rejected: WorkspaceProviderEntry[];
}

/**
 * Sort the providers only workspace layers define into approved, pending and rejected.
 *
 * @param workspaceLayers - the workspace layers' provider maps, in merge order
 * @param trustedIds - ids a trusted layer defines; those are never workspace-declared
 * @param decisions - the user's recorded decisions, from the trust store or a trusted layer
 */
export function partitionWorkspaceProviders(
  workspaceLayers: readonly ProviderLayer[],
  trustedIds: ReadonlySet<string>,
  decisions: Readonly<Record<string, WorkspaceProviderChoice>> | undefined,
): WorkspaceProviderPartition {
  const merged = new Map<string, { declaration: Record<string, unknown>; layers: string[] }>();
  for (const layer of workspaceLayers) {
    for (const [id, entry] of Object.entries(layer.providers ?? {})) {
      if (trustedIds.has(id) || !usableId(id) || !isPlainObject(entry)) continue;
      const existing = merged.get(id) ?? { declaration: {}, layers: [] };
      existing.declaration = mergeDeclaration(existing.declaration, entry);
      existing.layers.push(layer.path);
      merged.set(id, existing);
    }
  }

  const partition: WorkspaceProviderPartition = { approved: [], pending: [], rejected: [] };
  for (const [id, { declaration, layers }] of merged) {
    const typed = declaration as ProviderDeclaration;
    const fingerprint = workspaceProviderFingerprint(typed);
    const entry: WorkspaceProviderEntry = { id, declaration: typed, fingerprint, layers };
    const state = evaluateDecision(decisions, id, fingerprint);
    partition[state].push(entry);
  }
  return partition;
}

/** The model-selection keys a settings layer may carry. */
export const MODEL_SELECTION_KEYS = ['model', 'compactModel', 'advisorModel'] as const;
export type ModelSelectionKey = (typeof MODEL_SELECTION_KEYS)[number];

/** One layer's model selections, with whether the layer is trusted. */
export interface ModelSelectionLayer {
  path: string;
  trusted: boolean;
  selections: Partial<Record<ModelSelectionKey, string | undefined>>;
}

/** A model selection a workspace layer made that names a withheld workspace provider. */
export interface WithheldModelSelection {
  key: ModelSelectionKey;
  value: string;
  providerId: string;
  /** The workspace layer the value came from. */
  path: string;
  /** What applies instead: the trusted layers' own value, or `undefined` when they set none. */
  fallback: string | undefined;
}

/** The `<provider>` of a `<provider>/<model>` id, or undefined for a bare or malformed one. */
export function providerPrefixOf(model: string): string | undefined {
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  return slash > 0 ? trimmed.slice(0, slash) : undefined;
}

/**
 * The model selections whose merged value came from a workspace layer and names a withheld
 * workspace provider. A selection that names a trusted provider, an approved workspace provider
 * or no provider is left alone, and so is one a trusted layer made last.
 *
 * @param layers - in merge order, trusted layers included: the last layer to set a key is the one
 *   whose value the merge keeps, and a trusted layer after a workspace layer outranks it.
 */
export function withheldModelSelections(
  layers: readonly ModelSelectionLayer[],
  withheldIds: ReadonlySet<string>,
): WithheldModelSelection[] {
  const withheld: WithheldModelSelection[] = [];
  for (const key of MODEL_SELECTION_KEYS) {
    let winner: { value: string; layer: ModelSelectionLayer } | undefined;
    let trustedValue: string | undefined;
    for (const layer of layers) {
      const value = layer.selections[key];
      if (value === undefined) continue;
      winner = { value, layer };
      if (layer.trusted) trustedValue = value;
    }
    if (!winner || winner.layer.trusted) continue;
    const providerId = providerPrefixOf(winner.value);
    if (providerId === undefined || !withheldIds.has(providerId)) continue;
    withheld.push({
      key,
      value: winner.value,
      providerId,
      path: winner.layer.path,
      fallback: trustedValue,
    });
  }
  return withheld;
}

/**
 * Why a request on `rawModel` may not be made: its provider is declared by the workspace and the
 * user has not approved it. The id is repository-authored text on its way to a terminal.
 */
export function workspaceProviderRefusal(providerId: string, rawModel: string): string {
  const id = renderUntrustedText(providerId, 64);
  return (
    `Model "${renderUntrustedText(rawModel)}" names provider "${id}", which is declared by the ` +
    `workspace and has not been approved. It needs \`book trust provider ${id}\` before Book ` +
    'sends it a request or resolves its key.'
  );
}

/**
 * Record an approve/reject decision for one workspace-declared provider (or, under
 * {@link LEGACY_BASE_URL_ID}, a legacy `baseUrl`), leaving every other recorded decision — in this
 * workspace and in every other — untouched.
 */
export function persistWorkspaceProviderChoice(
  workspace: string,
  id: string,
  fingerprint: string,
  choice: WorkspaceProviderChoice['choice'],
  storePath?: string,
): { ok: boolean; error?: string } {
  return updateWorkspaceTrust(
    workspace,
    (trust) => {
      trust.workspaceProviders[id] = { fingerprint, choice } satisfies WorkspaceProviderChoice;
    },
    storePath,
  );
}

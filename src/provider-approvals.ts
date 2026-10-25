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
 *   trusted layer's origin, key and protocol. A workspace layer's `baseURL`, `baseUrl`, `apiKey`,
 *   `type` and `api` for that id are dropped before merging (`type` decides how the key is sent:
 *   as a bearer token, or as `x-api-key` to `/v1/messages`; `api` which OpenAI path receives
 *   it); only its `models` entries still merge.
 * - A provider id **only workspace layers define** is held back until the user approves it in the
 *   user-global trust store (`workspace-trust.ts`), against a fingerprint of its declared type,
 *   API, origin and key reference. Changing any of those re-withholds it. An approved one is merged in,
 *   but it never inherits a key: only its own `apiKey` is sent (see `resolveModelProviderConfig`).
 *
 * Everything here is pure except {@link persistWorkspaceProviderChoice}: the loader and the
 * reporting hosts call the same functions, so what is enforced and what is reported cannot drift.
 */
import { createHash } from 'crypto';
import type { ProviderConfig, WorkspaceProviderChoice } from './settings.js';
import { renderUntrustedText } from './hook-approvals.js';
import { parseSecretReference, resolveSecretFilePath } from './secret-reference.js';
import { providerTrustCommand } from './trust-command.js';
import { updateWorkspaceTrust } from './workspace-trust.js';

/** A provider entry as a settings file wrote it: every key optional, nothing defaulted. */
export type ProviderDeclaration = Partial<ProviderConfig>;

/** One settings layer's `provider` map. */
export type ProviderMap = Readonly<Record<string, ProviderDeclaration>>;

/**
 * The decision-store key for a legacy `.bookrc.json` `baseUrl`, which is not a provider. The id is
 * reserved: a workspace provider literally named this is never approvable (see
 * {@link WorkspaceProviderPartition.reserved}), so it cannot share the legacy decision.
 */
export const LEGACY_BASE_URL_ID = '.bookrc.json';

/**
 * The keys of a provider entry that choose where a request goes, which key it carries or how that
 * key is sent. Everything but `models`, which sends nothing anywhere. The workspace gate drops
 * them from a workspace layer, and a `/model` save clears them from the local layer: one list, so
 * the two cannot drift.
 */
export const PROVIDER_CONNECTION_KEYS = ['baseURL', 'baseUrl', 'apiKey', 'type', 'api'] as const;

/**
 * The ids of the Sign in with ChatGPT providers in a registry: the ones a workspace selection may
 * never choose, since a model there bills the user's ChatGPT plan (#615). The one predicate both
 * gates use, the settings layers' and the legacy `.bookrc.json`'s, so they cannot disagree.
 */
export function chatGptProviderIds(
  registry: Readonly<Record<string, { type?: string } | undefined>>,
): Set<string> {
  return new Set(Object.keys(registry).filter((id) => registry[id]?.type === 'chatgpt'));
}

/** `__proto__` parses as an ordinary own key but assigning it would reach the prototype setter. */
function usableId(id: string): boolean {
  return id !== '__proto__';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Digest of everything the user is asked to trust about a workspace-declared provider: the
 * declared `type` and `api`, the origin (`baseURL ?? baseUrl`, as written) and the `apiKey`
 * exactly as written. A reference is fingerprinted as text, never resolved, so computing one
 * reads nothing. `models` stays out: a catalog entry sends nothing anywhere. `api` is digested
 * only when set, so a decision recorded before the key existed still matches its entry.
 */
export function workspaceProviderFingerprint(entry: ProviderDeclaration): string {
  const canonical = JSON.stringify({
    type: entry.type ?? 'openai',
    origin: entry.baseURL ?? entry.baseUrl ?? null,
    apiKey: entry.apiKey ?? null,
    ...(entry.api !== undefined ? { api: entry.api } : {}),
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
  /** Which of `baseURL`, `baseUrl`, `apiKey`, `type` and `api` the layer wrote. */
  keys: string[];
}

/**
 * The origin, key and protocol overrides a workspace layer wrote for a trusted provider. Pure:
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
      const keys = PROVIDER_CONNECTION_KEYS.filter((key) => entry[key] !== undefined);
      if (keys.length > 0) dropped.push({ path: layer.path, providerId, keys });
    }
  }
  return dropped;
}

/**
 * A workspace layer's provider map as the merge may see it: only the ids a trusted layer defines,
 * and for those only `models`. Workspace-only ids are not here — they reach the
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
    for (const key of PROVIDER_CONNECTION_KEYS) delete rest[key];
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
  /**
   * A provider named {@link LEGACY_BASE_URL_ID}: that id is where the decision about a legacy
   * `baseUrl` lives, so a decision recorded under it could not tell the two apart. Withheld
   * whatever the trust store holds, and never offered for approval.
   */
  reserved: WorkspaceProviderEntry[];
}

export function emptyWorkspaceProviderPartition(): WorkspaceProviderPartition {
  return { approved: [], pending: [], rejected: [], reserved: [] };
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

  const partition = emptyWorkspaceProviderPartition();
  for (const [id, { declaration, layers }] of merged) {
    const typed = declaration as ProviderDeclaration;
    const fingerprint = workspaceProviderFingerprint(typed);
    const entry: WorkspaceProviderEntry = { id, declaration: typed, fingerprint, layers };
    if (id === LEGACY_BASE_URL_ID) partition.reserved.push(entry);
    else partition[evaluateDecision(decisions, id, fingerprint)].push(entry);
  }
  return partition;
}

/** Every id only workspace layers declare, in any state. */
export function declaredProviderIds(partition: WorkspaceProviderPartition): string[] {
  return [
    ...partition.approved,
    ...partition.pending,
    ...partition.rejected,
    ...partition.reserved,
  ].map((entry) => entry.id);
}

/** The declared ids that are not in effect: pending, rejected or reserved. */
export function withheldProviderIds(partition: WorkspaceProviderPartition): string[] {
  return [...partition.pending, ...partition.rejected, ...partition.reserved].map(
    (entry) => entry.id,
  );
}

/** The model-selection keys a settings layer may carry at its top level. */
export const MODEL_SELECTION_KEYS = ['model', 'compactModel', 'advisorModel'] as const;
export type ModelSelectionKey = (typeof MODEL_SELECTION_KEYS)[number];

/** The slot label of one agent profile's `model`, as a report names it. */
export function profileModelKey(profile: string): string {
  return `agents.profiles.${profile}.model`;
}

/** The profile a {@link profileModelKey} label names, or undefined for a top-level key. */
export function profileOfModelKey(key: string): string | undefined {
  return /^agents\.profiles\.(.+)\.model$/.exec(key)?.[1];
}

/** What a settings document says about models, for {@link modelSelectionsOf}. */
export interface ModelSelectionSource {
  model?: string;
  compactModel?: string;
  advisorModel?: string;
  agents?: unknown;
}

/**
 * Every model selection a settings document makes, by slot label: the three top-level keys and
 * each agent profile's `model`. A profile model reaches a spawn as surely as `model` reaches the
 * session, so it is gated by the same rule.
 */
export function modelSelectionsOf(
  settings: ModelSelectionSource,
): Partial<Record<string, string | undefined>> {
  const selections: Partial<Record<string, string | undefined>> = {};
  for (const key of MODEL_SELECTION_KEYS) selections[key] = settings[key];
  const profiles = isPlainObject(settings.agents) ? settings.agents.profiles : undefined;
  if (isPlainObject(profiles)) {
    for (const [name, profile] of Object.entries(profiles)) {
      if (!usableId(name) || !isPlainObject(profile)) continue;
      if (typeof profile.model === 'string') selections[profileModelKey(name)] = profile.model;
    }
  }
  return selections;
}

/** One layer's model selections, with whether the layer is trusted. */
export interface ModelSelectionLayer {
  path: string;
  trusted: boolean;
  selections: Partial<Record<string, string | undefined>>;
}

/** A model selection a workspace layer made that names a withheld workspace provider. */
export interface WithheldModelSelection {
  /** The slot: `model`, `compactModel`, `advisorModel` or `agents.profiles.<name>.model`. */
  key: string;
  value: string;
  providerId: string;
  /** The workspace layer the value came from. */
  path: string;
  /** What applies instead: the trusted layers' own value, or `undefined` when they set none. */
  fallback: string | undefined;
  /**
   * `plan`: the provider is the user's own Sign in with ChatGPT provider, which a workspace may
   * not select, approved or not. Absent: the provider is a withheld workspace declaration.
   */
  reason?: 'plan';
}

/**
 * A model selection the user's own settings, `--model` or the environment made, whose prefix
 * names only a withheld workspace provider. It is unaffected: it resolves as it would had the
 * workspace not declared that provider. Approving the provider is what would change that.
 */
export interface UnaffectedModelSelection {
  key: string;
  value: string;
  providerId: string;
  /** Where it came from: a settings path, `--model` or an environment variable. */
  source: string;
}

/**
 * The `<provider>` of a `<provider>/<model>` id, or undefined for a bare or malformed one.
 *
 * The one place a model id is split, for the loader's gate and for `resolveModelProviderConfig`
 * alike, so the two cannot disagree about which provider an id names. The id is read trimmed: a
 * caller that resolves it must use the trimmed id too (`resolveModelProviderConfig` does).
 */
export function providerPrefixOf(model: string): string | undefined {
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  return slash > 0 ? trimmed.slice(0, slash) : undefined;
}

interface SelectionWinner {
  value: string;
  layer: ModelSelectionLayer;
  trustedValue: string | undefined;
}

/** The slots a set of layers makes selections in: the top-level keys first, then profiles. */
function selectionSlots(layers: readonly ModelSelectionLayer[]): string[] {
  const slots = new Set<string>(MODEL_SELECTION_KEYS);
  for (const layer of layers) for (const key of Object.keys(layer.selections)) slots.add(key);
  return [...slots];
}

/** The last layer to set `key` (the merge keeps its value) and the last trusted layer's value. */
function winnerOf(
  layers: readonly ModelSelectionLayer[],
  key: string,
): SelectionWinner | undefined {
  let winner: Pick<SelectionWinner, 'value' | 'layer'> | undefined;
  let trustedValue: string | undefined;
  for (const layer of layers) {
    const value = layer.selections[key];
    if (value === undefined) continue;
    if (layer.trusted) trustedValue = value;
    winner = { value, layer };
  }
  return winner && { ...winner, trustedValue };
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
  for (const key of selectionSlots(layers)) {
    const winner = winnerOf(layers, key);
    if (!winner || winner.layer.trusted) continue;
    const providerId = providerPrefixOf(winner.value);
    if (providerId === undefined || !withheldIds.has(providerId)) continue;
    withheld.push({
      key,
      value: winner.value,
      providerId,
      path: winner.layer.path,
      fallback: winner.trustedValue,
    });
  }
  return withheld;
}

/**
 * The model selections a trusted layer made last whose prefix names only a withheld workspace
 * provider. The counterpart of {@link withheldModelSelections}: those fall back, these stay, and
 * the user is told that nothing they chose moved.
 */
export function unaffectedModelSelections(
  layers: readonly ModelSelectionLayer[],
  withheldIds: ReadonlySet<string>,
): UnaffectedModelSelection[] {
  const unaffected: UnaffectedModelSelection[] = [];
  for (const key of selectionSlots(layers)) {
    const winner = winnerOf(layers, key);
    if (!winner?.layer.trusted) continue;
    const providerId = providerPrefixOf(winner.value);
    if (providerId === undefined || !withheldIds.has(providerId)) continue;
    unaffected.push({ key, value: winner.value, providerId, source: winner.layer.path });
  }
  return unaffected;
}

/** A selection the command line or the environment made, which outranks every settings layer. */
export interface EnvironmentSelection {
  key: ModelSelectionKey;
  value: string | undefined;
  /** `--model`, `BOOK_MODEL`, … */
  source: string;
}

/** The selections `--model` and the `BOOK_*` model variables make, in the order they outrank. */
export function environmentModelSelections(
  modelOverride: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentSelection[] {
  return [
    {
      key: 'model',
      value: modelOverride || env.BOOK_MODEL,
      source: modelOverride ? '--model' : 'BOOK_MODEL',
    },
    { key: 'compactModel', value: env.BOOK_COMPACT_MODEL, source: 'BOOK_COMPACT_MODEL' },
    { key: 'advisorModel', value: env.BOOK_ADVISOR_MODEL, source: 'BOOK_ADVISOR_MODEL' },
  ];
}

/**
 * {@link unaffectedModelSelections} as the session sees them: a selection `--model` or an
 * environment variable made replaces the settings layers' value for its key, so the layers' entry
 * for that key gives way to the one that is actually in effect.
 */
export function withEnvironmentSelections(
  unaffected: readonly UnaffectedModelSelection[],
  environment: readonly EnvironmentSelection[],
  withheldIds: ReadonlySet<string>,
): UnaffectedModelSelection[] {
  const set = environment.filter((selection) => selection.value);
  const overridden = new Set<string>(set.map((selection) => selection.key));
  const result = unaffected.filter((selection) => !overridden.has(selection.key));
  for (const { key, value, source } of set) {
    const providerId = providerPrefixOf(value!);
    if (providerId !== undefined && withheldIds.has(providerId)) {
      result.push({ key, value: value!, providerId, source });
    }
  }
  return result;
}

/** The legacy `.bookrc.json` `baseUrl`, and whether the user approved it. */
export interface LegacyBaseUrlGate {
  baseUrl: string;
  state: WorkspaceProviderState;
}

/**
 * What the provider gate did to one resolution (#418), for the config that carries it and for the
 * hosts that report it. Computed from the layer files themselves, never read back from a settings
 * key a workspace layer could write. Build one with {@link createWorkspaceProviderGate}.
 */
export interface WorkspaceProviderGate {
  /** Provider ids only workspace layers define: they never inherit a key. */
  declared: string[];
  /** The subset of {@link declared} that is withheld (pending, rejected or reserved). */
  withheld: string[];
  /** The same ids sorted by the user's decision on the declaration as written. */
  partition: WorkspaceProviderPartition;
  /** Origin, key and protocol overrides a workspace layer wrote for a trusted provider; dropped. */
  droppedOverrides: DroppedProviderOverride[];
  /** Model selections that fell back to the trusted layers' value. */
  withheldSelections: WithheldModelSelection[];
  /** The user's own selections that name only a withheld provider, and so are unaffected. */
  unaffectedSelections: UnaffectedModelSelection[];
  /** The legacy `.bookrc.json` `baseUrl`, when the workspace has one. */
  legacyBaseUrl?: LegacyBaseUrlGate;
}

/**
 * The one constructor of a gate: `declared` and `withheld` are derived from the partition here,
 * so they cannot name different providers than the partition sorts.
 */
export function createWorkspaceProviderGate(parts: {
  partition: WorkspaceProviderPartition;
  droppedOverrides?: DroppedProviderOverride[];
  withheldSelections?: WithheldModelSelection[];
  unaffectedSelections?: UnaffectedModelSelection[];
  legacyBaseUrl?: LegacyBaseUrlGate;
}): WorkspaceProviderGate {
  return {
    declared: declaredProviderIds(parts.partition),
    withheld: withheldProviderIds(parts.partition),
    partition: parts.partition,
    droppedOverrides: parts.droppedOverrides ?? [],
    withheldSelections: parts.withheldSelections ?? [],
    unaffectedSelections: parts.unaffectedSelections ?? [],
    legacyBaseUrl: parts.legacyBaseUrl,
  };
}

/** The most of an untrusted value a line shows: enough for any real host, path or name. */
const DISCLOSURE_LIMIT = 1024;

/**
 * How a declared origin reads in a disclosure: its parsed protocol, host and port, in full, never
 * the text as written. The written text can hide the real host behind a long run of characters
 * (`https://api.openai.com:` + filler + `@evil.example`), which a truncating renderer then cuts
 * off. A URL carrying userinfo, or not parsing as a URL at all, is flagged.
 */
export function describeOrigin(raw: string | undefined): string {
  if (raw === undefined) return '(no baseURL: the default endpoint)';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${renderUntrustedText(raw)} [!] not a valid URL`;
  }
  const origin = renderUntrustedText(`${url.protocol}//${url.host}`, DISCLOSURE_LIMIT);
  return url.username !== '' || url.password !== ''
    ? `${origin} [!] the URL has userinfo before the host; requests go to the host shown`
    : origin;
}

/**
 * How a declared `apiKey` reads in a disclosure: the variable an `{env:…}` reference names, the
 * file a `{file:…}` reference opens (normalised: `~` expanded and `..` resolved, in full), or a
 * note that a literal is present. Never a resolved value, and a literal is never echoed: it may
 * be a real credential.
 */
export function describeApiKeyDeclaration(apiKey: string | undefined, workspace: string): string {
  if (apiKey === undefined) return 'none';
  const reference = parseSecretReference(apiKey);
  if (reference.kind === 'env') {
    const name = renderUntrustedText(reference.name, DISCLOSURE_LIMIT);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.name)
      ? `environment variable ${name}`
      : `environment variable ${name} [!] not a valid variable name`;
  }
  if (reference.kind === 'file') {
    const file = resolveSecretFilePath(reference.path, workspace);
    const path = renderUntrustedText(file.path, DISCLOSURE_LIMIT);
    return file.readable
      ? `file ${path}`
      : `file ${path} [!] outside the workspace, so it would not be read`;
  }
  return 'a literal key (not shown)';
}

/** One provider as a decision is asked for it: id, declared origin and key reference. */
export function describeWorkspaceProvider(
  entry: WorkspaceProviderEntry,
  workspace: string,
  routed: readonly UnaffectedModelSelection[] = [],
): string[] {
  const origin = entry.declaration.baseURL ?? entry.declaration.baseUrl;
  // `api` is shown only when declared, as the fingerprint digests it only then.
  const api = entry.declaration.api;
  const lines = [
    `${renderUntrustedText(entry.id, 64)}  ${describeOrigin(origin)}  ` +
      `key: ${describeApiKeyDeclaration(entry.declaration.apiKey, workspace)}` +
      (api !== undefined ? `  api: ${renderUntrustedText(String(api), 32)}` : ''),
  ];
  if (routed.length > 0) {
    const named = routed
      .map(
        (selection) =>
          `${selection.key} "${renderUntrustedText(selection.value)}" ` +
          `(from ${renderUntrustedText(selection.source)})`,
      )
      .join(', ');
    lines.push(
      `[!] approving it also routes your own selections with this prefix to ${describeOrigin(origin)}: ` +
        `${named}`,
    );
  }
  return lines;
}

/** What approving a legacy `baseUrl` would send there; see {@link describeLegacyBaseUrl}. */
export interface LegacyApprovalContext {
  /** The resolved providers: the user's, and any approved workspace ones. */
  providers: Readonly<Record<string, ProviderDeclaration>>;
  workspace: string;
}

/**
 * The legacy `baseUrl` as a decision is asked for it. An approved one becomes the default
 * endpoint (`defaultBaseUrl`), so the disclosure names everything the default endpoint receives:
 * `BOOK_API_KEY`, the key of every provider that sets no `baseURL` of its own, and every model id
 * that names no provider.
 */
export function describeLegacyBaseUrl(baseUrl: string, context?: LegacyApprovalContext): string[] {
  const lines = [
    `${LEGACY_BASE_URL_ID}  ${describeOrigin(baseUrl)}  would become the default endpoint`,
  ];
  lines.push('  approving it sends there: BOOK_API_KEY');
  if (context) {
    const keyless = Object.entries(context.providers)
      .filter(([, provider]) => provider.baseURL === undefined && provider.baseUrl === undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([id, provider]) =>
          `${renderUntrustedText(id, 64)} (key: ${describeApiKeyDeclaration(provider.apiKey, context.workspace)})`,
      );
    lines.push(
      keyless.length === 0
        ? '  approving it sends there: no provider key (every configured provider sets its own baseURL)'
        : `  approving it sends there: the requests and key of each provider with no baseURL: ${keyless.join(', ')}`,
    );
  }
  lines.push(
    '  approving it sends there: every plain model id (gpt-4o) and every <vendor>/<model> id that names no configured provider',
  );
  return lines;
}

/** One dropped override as a report reads it, without a leading marker. */
export function describeDroppedOverride(dropped: DroppedProviderOverride): string {
  return (
    `${dropped.keys.join(', ')} for provider "${renderUntrustedText(dropped.providerId, 64)}" in ` +
    `${renderUntrustedText(dropped.path)} ignored: you defined that provider yourself, so a ` +
    'workspace file cannot change where its key goes or how it is sent. `book trust provider` ' +
    'does not apply to it; to use another origin, key or type, set it in your own settings ' +
    '(~/.book/settings.json).'
  );
}

/** One withheld model selection as a report reads it, without a leading marker. */
export function describeWithheldSelection(selection: WithheldModelSelection): string {
  const id = renderUntrustedText(selection.providerId, 64);
  const instead =
    selection.fallback === undefined
      ? 'the trusted settings set none, so the default applies'
      : `"${renderUntrustedText(selection.fallback)}" is used instead`;
  if (selection.reason === 'plan') {
    return (
      `${selection.key} "${renderUntrustedText(selection.value)}" from ` +
      `${renderUntrustedText(selection.path)} ignored: "${id}" bills your ChatGPT plan, and only ` +
      `your own settings, --model or /model may choose it; ${instead}.`
    );
  }
  return (
    `${selection.key} "${renderUntrustedText(selection.value)}" from ` +
    `${renderUntrustedText(selection.path)} ignored: it names the workspace provider "${id}", ` +
    `which is not approved; ${instead}.`
  );
}

/** One unaffected selection as a report reads it, without a leading marker. */
export function describeUnaffectedSelection(selection: UnaffectedModelSelection): string {
  const id = renderUntrustedText(selection.providerId, 64);
  return (
    `provider "${id}" declared by the workspace is withheld; your ${selection.key} ` +
    `"${renderUntrustedText(selection.value)}" (from ${renderUntrustedText(selection.source)}) ` +
    'is unaffected and resolves as it would had the workspace not declared that provider.'
  );
}

/** A provider the workspace named with the reserved legacy id, as a report reads it. */
export function describeReservedProvider(entry: WorkspaceProviderEntry): string {
  return (
    `workspace provider "${renderUntrustedText(entry.id, 64)}" from ` +
    `${entry.layers.map((layer) => renderUntrustedText(layer)).join(', ')} ignored: that id is ` +
    `reserved for the decision about a legacy ${LEGACY_BASE_URL_ID} baseUrl, so it can never be ` +
    'approved. Rename the provider.'
  );
}

/**
 * Why a request on `rawModel` may not be made: its provider is declared by the workspace and the
 * user has not approved it. The id is repository-authored text on its way to a terminal, and into
 * a command the user may paste: the command is built by {@link providerTrustCommand}.
 */
export function workspaceProviderRefusal(
  providerId: string,
  rawModel: string,
  workspace: string,
): string {
  const id = renderUntrustedText(providerId, 64);
  const { command, note } = providerTrustCommand(workspace, providerId);
  return (
    `Model "${renderUntrustedText(rawModel)}" names provider "${id}", which is declared by the ` +
    `workspace and has not been approved. It needs \`${command}\`${note} before Book ` +
    'sends it a request or resolves its key.'
  );
}

/**
 * What resolving a model on a withheld workspace provider throws. A class of its own so a caller
 * that otherwise tolerates a model it cannot resolve (a managed-agent spawn defers that to the
 * run) can tell this one apart: it is a decision waiting for the user, not a typo.
 */
export class WorkspaceProviderRefusalError extends Error {
  constructor(
    readonly providerId: string,
    rawModel: string,
    workspace: string,
  ) {
    super(workspaceProviderRefusal(providerId, rawModel, workspace));
    this.name = 'WorkspaceProviderRefusalError';
  }
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

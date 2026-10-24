import { resolveModelProviderConfig } from '../config.js';
import { AVAILABLE_MODELS, modelSupportsEffort } from '../models.js';
import { providerPrefixOf } from '../provider-approvals.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ProviderConfig, ResolvedSettings } from '../settings.js';
import {
  normalizeProviderBaseUrl,
  type DiscoveredModel,
  type ProviderProtocol,
} from '../provider/model-discovery.js';

// The CLI's `book config provider-key` accepts what the wizard's key step does, so the validator
// lives outside `tui/` now.
export { validateApiKey } from '../provider-key.js';

export interface ModelPickerOption {
  id: string;
  label: string;
  effort: boolean;
  custom: boolean;
  providerId?: string;
}

export interface ByokProviderDraft {
  providerId: string;
  type: ProviderProtocol;
  baseURL: string;
  apiKey: string;
  models: DiscoveredModel[];
  activeModelId: string;
  activeLabel?: string;
}

export interface ProviderSaveRequest extends ByokProviderDraft {
  replaceModels?: boolean;
  /** False when refreshing a catalog without changing the active model. */
  activate?: boolean;
  /** True when `models` were typed by hand instead of discovered. */
  manual?: boolean;
}

export function buildModelOptions(settings: ResolvedSettings): ModelPickerOption[] {
  const options = new Map<string, ModelPickerOption>();
  for (const model of AVAILABLE_MODELS) {
    options.set(model.id, {
      id: model.id,
      label: model.label,
      effort: Boolean(model.effort),
      custom: false,
    });
  }

  for (const providerId of Object.keys(settings.provider).sort()) {
    const provider = settings.provider[providerId];
    for (const modelId of Object.keys(provider.models).sort()) {
      const id = `${providerId}/${modelId}`;
      const metadata = provider.models[modelId];
      const existing = options.get(id);
      options.set(id, {
        id,
        label: metadata.label ?? existing?.label ?? modelId,
        effort:
          metadata.effort === false
            ? false
            : typeof metadata.effort === 'object'
              ? true
              : (existing?.effort ?? modelSupportsEffort(modelId)),
        custom: true,
        providerId,
      });
    }
  }
  return [...options.values()];
}

/**
 * The notes under the advisor picker. It is the one picker whose current value
 * can be text the user typed rather than a row they picked, so it says when that
 * value names nothing in the list (a saved `"claude"` is the usual case), and,
 * as the main picker does for `BOOK_MODEL`, when `BOOK_ADVISOR_MODEL` will
 * outrank whatever is chosen here at the next launch.
 */
export function advisorPickerWarnings(
  advisor: string | undefined,
  options: ReadonlyArray<{ id: string }>,
  envOverride: string | undefined,
): string[] {
  const warnings: string[] = [];
  if (envOverride) {
    warnings.push(
      `BOOK_ADVISOR_MODEL is set to "${envOverride}" — it overrides advisorModel on next startup.`,
    );
  }
  if (advisor && !options.some((option) => option.id === advisor)) {
    warnings.push(`Current advisor "${advisor}" is not in your model list.`);
  }
  return warnings;
}

export function validateProviderId(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new Error('Use 1–64 lowercase letters, numbers, hyphens, or underscores.');
  }
  return value;
}

export function validateModelId(raw: string): string {
  const value = raw.trim();
  if (!value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Enter a model ID of 1–256 characters without control characters.');
  }
  return value;
}

/**
 * Split a hand-typed model list on commas or newlines so one prompt can add
 * several models at once. Order is preserved and duplicates collapse.
 */
export function parseModelIds(raw: string): string[] {
  const ids: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    if (!part.trim()) continue;
    const id = validateModelId(part);
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw new Error('Enter at least one model ID.');
  return ids;
}

export function validateDisplayLabel(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Use at most 100 characters without control characters.');
  }
  return value;
}

export function validateBaseUrl(type: ProviderProtocol, raw: string): string {
  return normalizeProviderBaseUrl(type, raw);
}

export function providerConfigFromDraft(
  draft: ProviderSaveRequest,
  existing?: ProviderConfig,
  replaceModels = false,
): ProviderConfig {
  // A refresh replaces the discovered catalog with whatever the endpoint now
  // reports, but hand-entered models survive it: they were typed in because
  // the model-list API does not return them, so dropping them here would undo
  // the user's work on every refresh.
  const models: ProviderConfig['models'] = replaceModels
    ? Object.fromEntries(
        Object.entries(existing?.models ?? {}).filter(([, metadata]) => metadata.manual),
      )
    : { ...(existing?.models ?? {}) };
  for (const model of draft.models) {
    const previous = existing?.models[model.id];
    models[model.id] = {
      ...previous,
      label:
        model.id === draft.activeModelId
          ? (draft.activeLabel ?? model.label ?? previous?.label)
          : (model.label ?? previous?.label),
      manual: draft.manual ? true : undefined,
    };
    // The reported window is the endpoint's current answer, so it replaces whatever an earlier
    // discovery wrote, and goes away when the endpoint no longer reports one. `contextWindow` is
    // the user's: `...previous` carries it untouched and discovery never sets it.
    if (model.reportedContextWindow !== undefined) {
      models[model.id].reportedContextWindow = model.reportedContextWindow;
    } else {
      delete models[model.id].reportedContextWindow;
    }
    if (!models[model.id].label) delete models[model.id].label;
    // Discovery now vouches for this id, so it no longer needs the manual
    // marker to survive the next refresh.
    if (!models[model.id].manual) delete models[model.id].manual;
  }
  // Only overwrite credentials the draft actually carries; adding a model to an
  // existing provider leaves its base URL and key exactly as configured.
  const config: ProviderConfig = { ...existing, type: draft.type, models };
  if (draft.baseURL) {
    config.baseURL = draft.baseURL;
    // Readers prefer `baseURL`, so a surviving legacy `baseUrl` would sit in
    // settings.json as a stale value that looks live.
    delete config.baseUrl;
  }
  if (draft.apiKey) config.apiKey = draft.apiKey;
  return config;
}

/**
 * The provider entry a save writes to the user-global settings file.
 *
 * `own` is the user file's entry for the id, never the merged one: the picker lists the resolved
 * providers, which hold values a workspace layer contributed (its `models`, and once its `type`),
 * and persisting those would copy repository-authored values into the user's own file. A refresh
 * or a hand-typed model only changes the catalog, so it keeps the type, origin and key `own` has
 * and ignores the ones the request carries. The wizard, which the user fills in, writes what it
 * was given.
 */
export function providerConfigForSave(
  request: ProviderSaveRequest,
  own: ProviderConfig | undefined,
): ProviderConfig {
  const catalogOnly = Boolean(request.replaceModels || request.manual);
  const draft: ProviderSaveRequest =
    own && catalogOnly ? { ...request, type: own.type, baseURL: '', apiKey: '' } : request;
  return providerConfigFromDraft(draft, own, request.replaceModels);
}

/**
 * A save that does not activate (a catalog refresh) updates `settings.provider` and leaves the
 * live `modelInfo` as it was, so `/context`, the status line and compaction would keep the old
 * window until restart. When the live selection belongs to `providerId`, re-resolve just its
 * `modelInfo` from the provider `config.settings` now holds; the selection, effort, maxTokens and
 * everything else stay as they are. Any other selection returns `config` itself.
 */
export function refreshLiveModelInfo(config: AgentConfig, providerId: string): AgentConfig {
  const selection = (config.modelSelection ?? config.model).trim();
  if (providerPrefixOf(selection) !== providerId) return config;
  const { modelInfo } = resolveModelProviderConfig(config, selection, { trustedSelection: true });
  return { ...config, modelInfo };
}

/**
 * A key update (`Alt+K`) changes `settings.provider[providerId].apiKey`, but the live request key is
 * `config.apiKey`, resolved when the model was selected. When the live selection belongs to
 * `providerId`, re-resolve just that key from the provider `config.settings` now holds, so the next
 * request carries the new one; everything else stays. Any other selection returns `config` itself:
 * the compact, advisor and subagent models resolve their key from `settings.provider` when they run.
 */
export function refreshLiveProviderKey(config: AgentConfig, providerId: string): AgentConfig {
  const selection = (config.modelSelection ?? config.model).trim();
  if (providerPrefixOf(selection) !== providerId) return config;
  const { apiKey } = resolveModelProviderConfig(config, selection, { trustedSelection: true });
  return { ...config, apiKey };
}

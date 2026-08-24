import { AVAILABLE_MODELS, modelSupportsEffort } from '../models.js';
import type { ProviderConfig, ResolvedSettings } from '../settings.js';
import {
  normalizeProviderBaseUrl,
  type DiscoveredModel,
  type ProviderProtocol,
} from '../provider/model-discovery.js';

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

export function validateApiKey(raw: string): string {
  if (!raw.trim()) throw new Error('API key is required.');
  if (/[\r\n\x00]/.test(raw)) throw new Error('API key cannot contain line breaks.');
  return raw;
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

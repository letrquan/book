/**
 * What follows a successful sign-in: the plan's model list, recorded as a provider entry of
 * `type: "chatgpt"` in the user's own settings file, so the models show in `/model` and resolve
 * as `<id>/<model>`. Opt-in all the same: the entry selects nothing, `model` is never written,
 * and only a model the user then chooses is billed to the plan.
 */

import {
  readSettingsDocument,
  SettingsRepository,
  formatSettingsDiagnostics,
} from '../settings-repository.js';
import { settingsScopePath } from '../settings-scope.js';
import { discoverChatGptModels, type DiscoveredModel } from '../provider/model-discovery.js';
import {
  chatGptAccessToken,
  chatGptEndpoints,
  type ChatGptRequestOptions,
} from './chatgpt-oauth.js';

export const CHATGPT_DEFAULT_PROVIDER_ID = 'chatgpt';

export interface ChatGptProviderSetup {
  /** The user-file provider id the plan's models are under, when there is one. */
  providerId?: string;
  models: DiscoveredModel[];
  /** The settings file written, when one was. */
  path?: string;
  /** Why no entry was written. */
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The id of the user file's first `type: "chatgpt"` entry, if it has one. */
function chatGptEntryId(document: Record<string, unknown>): string | undefined {
  const registry = isRecord(document.provider) ? document.provider : {};
  return Object.keys(registry)
    .sort()
    .find((id) => isRecord(registry[id]) && registry[id].type === 'chatgpt');
}

/** The signed-in plan's listed models, asked with the current access token. */
export async function listChatGptPlanModels(
  options: ChatGptRequestOptions = {},
): Promise<DiscoveredModel[]> {
  const accessToken = await chatGptAccessToken(options);
  return discoverChatGptModels({
    apiBase: chatGptEndpoints(options.env).apiBase,
    accessToken,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  });
}

/**
 * The user-file provider id the plan's models go under: the first `type: "chatgpt"` entry, or
 * `chatgpt`. An id the user already gave another provider is never taken over; `note` says why.
 */
export function chatGptProviderTarget(workspace: string): {
  path: string;
  providerId?: string;
  note?: string;
} {
  const path = settingsScopePath('user', workspace);
  const current = readSettingsDocument(path);
  if (current.status !== 'absent' && current.status !== 'valid') {
    return { path, note: `${path} could not be read (${current.error}); it was left as it is.` };
  }
  const document = current.status === 'valid' ? current.document : {};
  const registry = isRecord(document.provider) ? document.provider : {};
  const providerId = chatGptEntryId(document) ?? CHATGPT_DEFAULT_PROVIDER_ID;
  if (
    Object.hasOwn(registry, providerId) &&
    !(isRecord(registry[providerId]) && registry[providerId].type === 'chatgpt')
  ) {
    return {
      path,
      note:
        `provider.${providerId} in ${path} is another provider, so it was left as it is. Add an ` +
        'entry of {"type": "chatgpt"} under another id to use your plan.',
    };
  }
  return { path, providerId };
}

export async function recordChatGptProvider(
  workspace: string,
  options: ChatGptRequestOptions = {},
): Promise<ChatGptProviderSetup> {
  const models = await listChatGptPlanModels(options);
  if (models.length === 0) return { models, note: 'Your ChatGPT plan lists no models for Book.' };
  const { path, providerId, note } = chatGptProviderTarget(workspace);
  if (!providerId) return { models, note };
  const written = new SettingsRepository(path).update((candidate) => {
    const providers = isRecord(candidate.provider) ? candidate.provider : {};
    candidate.provider = providers;
    const entry = isRecord(providers[providerId]) ? providers[providerId] : {};
    const previous = isRecord(entry.models) ? entry.models : {};
    const next: Record<string, unknown> = {};
    for (const model of models) {
      // Overrides the user set on a model (a context window, an effort range) are kept.
      const prior = previous[model.id];
      const kept: Record<string, unknown> = isRecord(prior) ? prior : {};
      next[model.id] = { ...kept, ...(model.label ? { label: model.label } : {}) };
    }
    providers[providerId] = { ...entry, type: 'chatgpt', models: next };
  });
  if (!written.ok) {
    return { models, note: formatSettingsDiagnostics(written.diagnostics) };
  }
  return { providerId, models, path };
}

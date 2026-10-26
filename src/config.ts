import { readFileSync } from 'fs';
import type { AgentConfig, RetryConfig } from './types/runtime.js';
import { legacyConfigPath, legacyConfigSchema, parseLegacyConfig } from './legacy-config.js';
import { parseSecretReference, resolveSecretFilePath } from './secret-reference.js';
import {
  emptyWorkspaceProviderGate,
  resolveSettingsWithProviderGate,
  migrateLegacyPermissions,
  settingsLayerPaths,
  applySettingsEnvOverrides,
} from './settings-loader.js';
import {
  chatGptProviderIds,
  describeWithheldSelection,
  environmentModelSelections,
  evaluateLegacyBaseUrl,
  providerPrefixOf,
  withEnvironmentSelections,
  WorkspaceProviderRefusalError,
  type LegacyBaseUrlGate,
  type WithheldModelSelection,
  type WorkspaceProviderGate,
} from './provider-approvals.js';
import { defaultTrustStorePath, loadWorkspaceTrust } from './workspace-trust.js';
import { hadRemovedAuthConfiguration } from './settings-removed.js';
import { CHATGPT_LOGIN_COMMAND, chatGptEndpoints, hasChatGptTokens } from './auth/chatgpt-oauth.js';
import type { SettingsResolutionPaths } from './settings-loader.js';
import {
  ADVISOR_OFF_VALUE,
  DEFAULT_SETTINGS,
  type CompactStrategy,
  type ResolvedSettings,
} from './settings.js';
import { loadMemoryContext } from './memory-store.js';
import { EFFORT_LEVELS, getAvailableEffortLevels, isEffortLevel } from './commands/effort.js';
import { createModelWindowStore, type ModelWindowStore } from './model-window-store.js';
import { resolveShell } from './shell-selection.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** Conservative per-request output budget when a model provides no metadata. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

export { legacyConfigSchema };

/**
 * Try to load a legacy .bookrc.json file (v0.1.0 format, deprecated) from the workspace root.
 * Returns partial config if found, null otherwise. Emits a deprecation warning. The parse is
 * `parseLegacyConfig`, which `book trust` and doctor share, so they fingerprint what this reads.
 */
function loadLegacyConfig(workspace: string): Partial<AgentConfig> | null {
  const parsed = parseLegacyConfig(workspace);
  if (!parsed) return null;
  console.warn(
    '⚠  .bookrc.json is deprecated. Move your settings to .book/settings.json (project), ' +
      '.book/settings.local.json (local overrides), or ~/.book/settings.json (user).',
  );
  return {
    model: parsed.model,
    baseUrl: parsed.baseUrl,
    maxTurns: parsed.maxTurns,
    maxTokens: parsed.maxTokens,
    autoCompactEnabled: parsed.autoCompactEnabled,
    animation: parsed.animation,
    accessibility: parsed.accessibility,
  };
}

export interface LoadConfigOptions {
  /** Path to an ad-hoc settings file (--settings flag); takes highest priority. */
  settingsOverridePath?: string;
  /** If true, skip all settings.json layers entirely (use defaults + legacy .bookrc.json). */
  noSettings?: boolean;
  /** Run storage migrations after effective settings are validated. */
  runMigrations?: boolean;
  /** CLI -m/--model override, applied before provider registry resolution. */
  modelOverride?: string;
  /**
   * CLI --effort override. Passed in rather than assigned after the fact so it
   * counts as an explicit choice: model metadata must not override a level the
   * user typed, and providers that gate on `effortExplicit` must see it.
   */
  effortOverride?: AgentConfig['effort'];
  /**
   * Redirect individual settings layers. Pointing one at a path that does not
   * exist drops it from the merge, which is how `book doctor` finds the layer a
   * failure first appears in.
   */
  settingsPaths?: SettingsResolutionPaths;
  /** Let the interactive TUI start before a BYOK credential has been added. */
  allowMissingApiKey?: boolean;
  /** Optional store for learned context window ceilings. */
  modelWindowStore?: ModelWindowStore;
}

export function loadConfig(workspace?: string, options?: LoadConfigOptions): AgentConfig {
  const settingsOverridePath = options?.settingsOverridePath;
  const noSettings = options?.noSettings ?? false;
  const resolvedWorkspace = workspace || process.env.BOOK_WORKSPACE || process.cwd();

  // Resolve layered settings.json from user/project/local scopes, or skip
  // entirely when --no-settings is set (useful for scripted/isolated runs).
  const resolveLayers = () =>
    noSettings
      ? { settings: structuredClone(DEFAULT_SETTINGS), providerGate: emptyWorkspaceProviderGate() }
      : resolveSettingsWithProviderGate(
          resolvedWorkspace,
          settingsOverridePath,
          options?.settingsPaths,
        );
  let { settings, providerGate } = resolveLayers();

  if (!noSettings && options?.runMigrations) {
    const migrated = migrateLegacyPermissions(resolvedWorkspace, undefined, settings);
    if (migrated) ({ settings, providerGate } = resolveLayers());
  }

  // The startup splash is on by default, so anything that drives Book rather
  // than using it has to switch it off — and a settings layer is the wrong place
  // to say so, since Book reads one and a driver would have to merge whatever the
  // user passes. The variable outranks every layer, as `BOOK_MODEL` does for
  // `model`, and lands on the resolved settings so `shouldPlayStartupFire` and
  // `/config` read the same value.
  settings = applySettingsEnvOverrides(settings);

  // Load legacy .bookrc.json (deprecated) only after settings availability is accepted.
  const legacy = loadLegacyConfig(resolvedWorkspace);

  // Resolve retry configuration: env vars take precedence over settings.json.
  const retry: RetryConfig = {
    maxAttempts: process.env.BOOK_RETRY_MAX_ATTEMPTS
      ? clampInt(process.env.BOOK_RETRY_MAX_ATTEMPTS, 0, 15)
      : (settings.retry?.maxAttempts ?? DEFAULT_SETTINGS.retry.maxAttempts),
    baseDelayMs: process.env.BOOK_RETRY_BASE_DELAY_MS
      ? clampInt(process.env.BOOK_RETRY_BASE_DELAY_MS, 100, 60000)
      : (settings.retry?.baseDelayMs ?? DEFAULT_SETTINGS.retry.baseDelayMs),
    maxDelayMs: process.env.BOOK_RETRY_MAX_DELAY_MS
      ? clampInt(process.env.BOOK_RETRY_MAX_DELAY_MS, 100, 300000)
      : (settings.retry?.maxDelayMs ?? DEFAULT_SETTINGS.retry.maxDelayMs),
    totalBudgetMs: process.env.BOOK_RETRY_TOTAL_BUDGET_MS
      ? clampInt(process.env.BOOK_RETRY_TOTAL_BUDGET_MS, 0, 600000)
      : (settings.retry?.totalBudgetMs ?? DEFAULT_SETTINGS.retry.totalBudgetMs),
    requestTimeoutMs: process.env.BOOK_REQUEST_TIMEOUT_MS
      ? clampInt(process.env.BOOK_REQUEST_TIMEOUT_MS, 5000, 600000)
      : (settings.retry?.requestTimeoutMs ?? DEFAULT_SETTINGS.retry.requestTimeoutMs),
    streamStallTimeoutMs: process.env.BOOK_STREAM_STALL_TIMEOUT_MS
      ? clampInt(process.env.BOOK_STREAM_STALL_TIMEOUT_MS, 5000, 120000)
      : (settings.retry?.streamStallTimeoutMs ?? DEFAULT_SETTINGS.retry.streamStallTimeoutMs),
    thinkingStallTimeoutMs: process.env.BOOK_THINKING_STALL_TIMEOUT_MS
      ? clampInt(process.env.BOOK_THINKING_STALL_TIMEOUT_MS, 10_000, 1_800_000)
      : (settings.retry?.thinkingStallTimeoutMs ?? DEFAULT_SETTINGS.retry.thinkingStallTimeoutMs),
    firstDeltaStallTimeoutMs: process.env.BOOK_FIRST_DELTA_STALL_TIMEOUT_MS
      ? clampInt(process.env.BOOK_FIRST_DELTA_STALL_TIMEOUT_MS, 5_000, 1_800_000)
      : (settings.retry?.firstDeltaStallTimeoutMs ??
        DEFAULT_SETTINGS.retry.firstDeltaStallTimeoutMs),
    toolRetries: process.env.BOOK_TOOL_RETRIES
      ? clampInt(process.env.BOOK_TOOL_RETRIES, 0, 3)
      : (settings.retry?.toolRetries ?? DEFAULT_SETTINGS.retry.toolRetries),
    watchdog: process.env.BOOK_RETRY_WATCHDOG === '1' || settings.retry?.watchdog === true,
    streamReissueAttempts: process.env.BOOK_STREAM_REISSUE_ATTEMPTS
      ? clampInt(process.env.BOOK_STREAM_REISSUE_ATTEMPTS, 0, 10)
      : (settings.retry?.streamReissueAttempts ?? DEFAULT_SETTINGS.retry.streamReissueAttempts),
    outputCapContinuations:
      settings.retry?.outputCapContinuations ?? DEFAULT_SETTINGS.retry.outputCapContinuations,
  };

  const memoryContext = settings.memory.enabled ? loadMemoryContext(resolvedWorkspace) : undefined;

  const envMaxTokens = parsePositiveInt(process.env.BOOK_MAX_TOKENS, 'BOOK_MAX_TOKENS');
  const maxTokensExplicit =
    envMaxTokens !== undefined ||
    settings.maxTokens !== undefined ||
    legacy?.maxTokens !== undefined;
  // "Explicit" means a human chose this level -- by flag, env var, or settings --
  // as opposed to a default or a value inferred from model metadata. Both
  // consumers depend on that one meaning: applyModelDefaults declines to override
  // an explicit level, and the OpenAI-compatible path sends `reasoning_effort`
  // only for one. Omitting the flag left `--effort` accepted, reported, and
  // discarded on that path.
  const effortExplicit = Boolean(
    options?.effortOverride || process.env.BOOK_EFFORT || settings.effort,
  );
  // A legacy `.bookrc.json` `model` is a workspace layer's selection, and the lowest: it applies
  // only when nothing above it names a model. Naming a withheld workspace provider, it gives way
  // to the default, as a `model` in a settings layer gives way to the trusted layers' (#418).
  const withheldIds = new Set(providerGate.withheld);
  const selectedModel = options?.modelOverride || process.env.BOOK_MODEL || settings.model;
  // Nor may it name the user's own Sign in with ChatGPT provider: a repository can ship the file,
  // and only the user chooses a model billed to their ChatGPT plan (#615).
  const withheldLegacyModel: WithheldModelSelection | undefined =
    selectedModel || legacy?.model === undefined
      ? undefined
      : withheldLegacyModelSelection({
          legacyModel: legacy.model,
          path: legacyConfigPath(resolvedWorkspace),
          withheldIds,
          planIds: chatGptProviderIds(settings.provider),
        });
  const legacyChosen = !selectedModel && !withheldLegacyModel && legacy?.model !== undefined;
  const rawModel = selectedModel || (legacyChosen ? legacy?.model : undefined) || 'gpt-4o';
  const compactModel = process.env.BOOK_COMPACT_MODEL || settings.compactModel;
  const advisorModel = process.env.BOOK_ADVISOR_MODEL || settings.advisorModel;
  const compactEffort = settings.compactEffort;
  const compactStrategy: CompactStrategy = 'summary';
  // Resolved once here: the Bash tool, the system prompt, and `book doctor`
  // must all name the same shell for the whole session.
  const shell = resolveShell({ requested: settings.shell });
  const defaultApiKey = process.env.BOOK_API_KEY || '';
  // A `.bookrc.json` `baseUrl` receives BOOK_API_KEY, and the file ships with a repository, so it
  // is honoured only once the user has approved that exact URL (#418). `--no-settings` reads no
  // settings layer, but the decision lives in the trust store, so it is still consulted.
  const legacyBaseUrlGate: LegacyBaseUrlGate | undefined =
    legacy?.baseUrl === undefined
      ? undefined
      : {
          baseUrl: legacy.baseUrl,
          state: evaluateLegacyBaseUrl(
            noSettings
              ? loadWorkspaceTrust(
                  resolvedWorkspace,
                  options?.settingsPaths?.trustStorePath ??
                    defaultTrustStorePath(options?.settingsPaths?.home),
                ).workspaceProviders
              : settings.workspaceProviders,
            legacy.baseUrl,
          ),
        };
  const legacyBaseUrl =
    legacyBaseUrlGate?.state === 'approved' ? legacyBaseUrlGate.baseUrl : undefined;
  const explicitBaseUrl = process.env.BOOK_BASE_URL || legacyBaseUrl;
  const defaultProviderOverride = validateProvider(process.env.BOOK_PROVIDER) || 'auto';

  const defaultBaseUrl = explicitBaseUrl || DEFAULT_OPENAI_BASE_URL;
  const defaultMaxTokens =
    envMaxTokens ?? settings.maxTokens ?? legacy?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const defaultEffort =
    options?.effortOverride || validateEffort(process.env.BOOK_EFFORT) || settings.effort || 'high';
  const defaultProvider = defaultProviderOverride;

  let config: AgentConfig = {
    apiKey: defaultApiKey,
    baseUrl: defaultBaseUrl,
    model: rawModel,
    modelSelection: rawModel,
    compactModel,
    advisorModel,
    compactEffort,
    compactStrategy,
    // Undefined = unlimited. Only set when env/settings/legacy explicitly provide a value.
    maxTurns: process.env.BOOK_MAX_TURNS
      ? parseInt(process.env.BOOK_MAX_TURNS, 10)
      : (settings.maxTurns ?? legacy?.maxTurns),
    maxTokens: defaultMaxTokens,
    maxTokensExplicit,
    defaultMaxTokens,
    effortExplicit,
    defaultEffort,
    defaultApiKey,
    defaultBaseUrl,
    defaultBaseUrlExplicit: Boolean(process.env.BOOK_BASE_URL),
    workspaceProviderGate: {
      ...providerGate,
      withheldSelections: withheldLegacyModel
        ? [...providerGate.withheldSelections, withheldLegacyModel]
        : providerGate.withheldSelections,
      // What `--model` and the environment chose counts too: those outrank every settings layer.
      unaffectedSelections: withEnvironmentSelections(
        providerGate.unaffectedSelections,
        environmentModelSelections(options?.modelOverride),
        withheldIds,
      ),
      legacyBaseUrl: legacyBaseUrlGate,
    },
    defaultProvider,
    autoCompactEnabled: settings.autoCompactEnabled ?? legacy?.autoCompactEnabled ?? true,
    workspace: resolvedWorkspace,
    animation: legacy?.animation || { typewriterSpeed: 3, spinnerStyle: 'braille' },
    accessibility: legacy?.accessibility || { screenReader: false, reducedMotion: false },
    settings,
    shell,
    settingsContext: {
      overridePath: settingsOverridePath,
      noSettings,
    },
    retry,
    memoryContext,
    effort: defaultEffort,
    provider: defaultProvider,
    modelWindowStore: options?.modelWindowStore ?? createModelWindowStore(),
  };

  // Every source of `rawModel` is the user's, or a workspace's that is not withheld: the loader
  // replaced a withheld workspace selection above. One naming a withheld provider is therefore
  // the user's own vendor-namespaced id, and resolves as the plain fallback. A legacy
  // `.bookrc.json` model is still the repository's choice, so it resolves untrusted: the
  // resolver's own refusals (a ChatGPT plan model among them) apply to it as well.
  config = applyModelDefaults(
    resolveModelProviderConfig(config, rawModel, { trustedSelection: !legacyChosen }),
  );
  // A withheld provider's prefix is reported as such, not as an unconfigured one.
  const rawPrefix = providerPrefixOf(rawModel);
  config.modelProviderWarning =
    rawPrefix !== undefined && withheldIds.has(rawPrefix)
      ? undefined
      : describeUnresolvedProviderPrefix(settings.provider, rawModel.trim());

  if (config.providerAuth === 'chatgpt') {
    // Checked on disk only: print mode and the SDK never open a browser, so a run with no
    // sign-in stops here with the command that makes one. The TUI starts, and says so per turn.
    if (!options?.allowMissingApiKey && !hasChatGptTokens()) {
      throw new Error(
        `Model "${config.modelSelection}" uses Sign in with ChatGPT, and this machine is not ` +
          `signed in. Run \`${CHATGPT_LOGIN_COMMAND}\` first.`,
      );
    }
  } else if (!config.apiKey && !options?.allowMissingApiKey) {
    // Someone whose only credential was a subscription profile arrives here
    // after their `auth` block was silently discarded by validation. Telling
    // them to set a key they never had describes a user who configured
    // nothing, not one whose working configuration was removed.
    // A plan model a repository chose was dropped above: say so, or the user is told to set a
    // key they never needed and never learns why their ChatGPT sign-in is not used.
    const droppedPlan = config.workspaceProviderGate?.withheldSelections.find(
      (selection) => selection.reason === 'plan' && selection.key === 'model',
    );
    throw new Error(
      'BOOK_API_KEY or provider.<id>.apiKey not set. Set BOOK_API_KEY ' +
        'or use {env:VAR} in settings.' +
        (droppedPlan
          ? `\n\n${describeWithheldSelection(droppedPlan)} To use your ChatGPT plan, choose ` +
            'the model yourself: ' +
            // The id is the repository's text: a command is suggested only for a plain id, never
            // one that could carry an option or shell syntax into what the user types.
            (SAFE_MODEL_ID.test(droppedPlan.value)
              ? `\`--model ${droppedPlan.value}\`, or "model" in ~/.book/settings.json.`
              : 'set "model" in ~/.book/settings.json.')
          : '') +
        (hadRemovedAuthConfiguration(
          noSettings
            ? []
            : settingsLayerPaths(resolvedWorkspace, settingsOverridePath, options?.settingsPaths),
          process.env,
        )
          ? '\n\nThe 0.3 subscription profiles (the `auth` block, BOOK_AUTH_* variables and ' +
            'auth.json) were removed, and nothing reads them any more; `book doctor` lists what ' +
            'is still on this machine and what to delete. Book authenticates with API keys, or, ' +
            'experimentally, with Sign in with ChatGPT (`book auth login` and a provider entry ' +
            'of type "chatgpt").'
          : ''),
    );
  }

  return config;
}

/** A model id plain enough to suggest in a command: no leading `-`, no whitespace or shell syntax. */
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;

/**
 * The key for a request routed to `baseUrl` whose own configuration names none:
 * BOOK_API_KEY, or else the key `config` already sends -- but only to the endpoint
 * it already sends it to. A key from `provider.anthropic` carried to another
 * provider's endpoint is the user's Anthropic key handed to another vendor: an
 * unprefixed `advisorModel` sent it to api.openai.com on every consult (#419).
 * With neither, the request goes out without a key, and fails as one.
 */
function inheritedApiKey(config: AgentConfig, baseUrl: string): string {
  // `||`, not `??`: `defaultApiKey` is `''` when BOOK_API_KEY is unset, and an
  // empty string is present as far as `??` is concerned. Switching models would
  // then wipe a key that came from a provider entry and send every later request
  // out with an empty credential.
  if (config.defaultApiKey) return config.defaultApiKey;
  return sameEndpoint(baseUrl, config.baseUrl) ? config.apiKey : '';
}

/**
 * Whether two base URLs name one endpoint: trailing slashes and the case of the scheme and
 * host do not matter, while a different host, port, scheme or path does. A string `new URL()`
 * rejects is compared as written, trimmed.
 */
function sameEndpoint(a: string, b: string): boolean {
  const normalise = (raw: string): string => {
    const trimmed = raw.trim();
    try {
      const url = new URL(trimmed);
      // `URL` lowercases the scheme and host, and drops a default port; only the path's
      // trailing slashes are ours to strip. Credentials stay: they are part of the endpoint.
      const auth = url.username || url.password ? `${url.username}:${url.password}@` : '';
      return `${url.protocol}//${auth}${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    } catch {
      return trimmed.replace(/\/+$/, '');
    }
  };
  return normalise(a) === normalise(b);
}

function plainModelConfig(config: AgentConfig, model: string): AgentConfig {
  const baseUrl = config.defaultBaseUrl || config.baseUrl;
  return {
    ...config,
    apiKey: inheritedApiKey(config, baseUrl),
    baseUrl,
    model,
    modelSelection: model,
    modelInfo: undefined,
    provider: config.defaultProvider ?? config.provider,
    providerApi: undefined,
    providerAuth: undefined,
  };
}

/** Whether a human chose the config's effort level; see `AgentConfig.effortChosen`. */
export function isEffortChosen(
  config: Pick<AgentConfig, 'effortChosen' | 'effortExplicit'>,
): boolean {
  return config.effortChosen ?? config.effortExplicit === true;
}

export function applyModelDefaults(config: AgentConfig): AgentConfig {
  const maxTokens = config.maxTokensExplicit
    ? config.maxTokens
    : (config.modelInfo?.maxOutputTokens ?? config.defaultMaxTokens ?? config.maxTokens);

  let effort = config.effort;
  if (!isEffortChosen(config)) {
    if (config.modelInfo?.effort === false) {
      effort = undefined;
    } else if (typeof config.modelInfo?.effort === 'object' && config.modelInfo.effort.default) {
      effort = config.modelInfo.effort.default;
    } else {
      effort = config.defaultEffort ?? effort;
    }
  }

  return { ...config, maxTokens, effort };
}

/** Freeze resolved configuration so runtime code cannot acquire mutable session state. */
export function freezeAgentConfig(config: AgentConfig): AgentConfig {
  return deepFreeze(config);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Describe a `<prefix>/` in a model id that matches no configured provider.
 *
 * The two forms are spelled identically: `9router/qc/qwen3.7-max` names a
 * configured provider, while `meta-llama/llama-3-70b` is one vendor-namespaced
 * model id that an OpenAI-compatible endpoint expects verbatim. An unmatched
 * prefix therefore cannot be rejected -- falling back to the plain id is right
 * for the second form, and that fallback is why nothing was ever said about the
 * first.
 *
 * Once the user has configured providers at all, though, a prefix matching none
 * of them is far more likely a typo than a namespace, and the fallback quietly
 * substitutes `https://api.openai.com/v1` -- an endpoint they never chose, for a
 * vendor that has never heard of the model. The only symptom is a separate
 * "credentials not resolved" line, which sends them looking for a missing key
 * rather than a misspelled provider id.
 */
export function describeUnresolvedProviderPrefix(
  providers: ResolvedSettings['provider'],
  rawModel: string,
): string | undefined {
  const slash = rawModel.indexOf('/');
  if (slash <= 0 || slash === rawModel.length - 1) return undefined;

  const prefix = rawModel.slice(0, slash);
  const configured = Object.keys(providers);
  if (configured.length === 0 || configured.includes(prefix)) return undefined;

  return (
    `Model "${rawModel}" names provider "${prefix}", which is not configured ` +
    `(configured: ${[...configured].sort().join(', ')}). ` +
    `Treating the whole id as a model name against the default endpoint. ` +
    `Add provider.${prefix} to settings, or use one of the configured ids.`
  );
}

/** Whether the workspace declared `providerId` and it is not in `settings.provider`. */
export function isWithheldWorkspaceProvider(config: AgentConfig, providerId: string): boolean {
  return (
    !Object.hasOwn(config.settings.provider, providerId) &&
    (config.workspaceProviderGate?.withheld.includes(providerId) ?? false)
  );
}

/** How a caller knows where a model id came from; see {@link resolveModelProviderConfig}. */
export interface ModelResolutionOptions {
  /**
   * The id is one the user chose (`--model`, `BOOK_MODEL`, their own settings, a model picked in
   * the session), or a workspace one the loader has already vetted. An id of that kind whose
   * prefix names only a withheld workspace provider is a vendor-namespaced model id the workspace
   * happens to share a prefix with, and resolves as the plain fallback.
   */
  trustedSelection?: boolean;
}

/**
 * Resolve "provider/model" strings through settings.provider, OpenCode-style.
 *
 * An id whose prefix names a provider the workspace declared and the user has not approved is not
 * "no provider" when the id came from a workspace-controlled place (an agent definition's `model`,
 * a model-chosen spawn argument): that throws {@link WorkspaceProviderRefusalError} naming the
 * command that decides it. The user's own selections opt out with `trustedSelection` (#418).
 *
 * The id is read trimmed, by `providerPrefixOf`, the same function the loader's gate uses to find
 * the provider an id names, so the two cannot disagree.
 */
export function resolveModelProviderConfig(
  config: AgentConfig,
  rawModel = config.model,
  options: ModelResolutionOptions = {},
): AgentConfig {
  const selection = rawModel.trim();
  const providerId = providerPrefixOf(selection);
  if (providerId === undefined) return plainModelConfig(config, selection);
  if (providerId.length === selection.length - 1) {
    throw new Error(`Invalid model "${selection}". Expected "provider/model".`);
  }

  const model = selection.slice(providerId.length + 1);
  // Own properties only: `constructor/x` names no provider, however `{}` answers for it.
  if (!Object.hasOwn(config.settings.provider, providerId)) {
    // A provider the workspace declared and the user has not approved is not "no provider" for an
    // id the workspace controls: the plain fallback would send it to the default endpoint with
    // BOOK_API_KEY (#418).
    if (!options.trustedSelection && isWithheldWorkspaceProvider(config, providerId)) {
      throw new WorkspaceProviderRefusalError(providerId, selection, config.workspace);
    }
    return plainModelConfig(config, selection);
  }
  const provider = config.settings.provider[providerId];

  if (provider.type === 'chatgpt') {
    // The plan token is the user's credential: a provider only a workspace declares never gets
    // it, approved or not, exactly as it never inherits a key (#418).
    if (config.workspaceProviderGate?.declared.includes(providerId)) {
      throw new Error(
        `provider.${providerId} is a ChatGPT sign-in provider that only this workspace declares. ` +
          'Book uses your ChatGPT sign-in only for a provider your own settings define: add ' +
          `"${providerId}": {"type": "chatgpt"} under "provider" in ~/.book/settings.json.`,
      );
    }
    // A model id a workspace controls (an agent definition, a model-chosen spawn) may not bill
    // the user's plan: only the user's own choices select a plan model.
    if (!options.trustedSelection) {
      throw new Error(
        `"${selection}" is a ChatGPT plan model, which only your own settings, --model or ` +
          '/model may choose; an agent definition or a delegated model id cannot.',
      );
    }
    // The endpoint, API and credential are fixed. `apiKey` stays empty: the token is read per
    // request (`src/provider/chatgpt.ts`), so no key is inherited in either direction.
    return {
      ...config,
      apiKey: '',
      baseUrl: chatGptEndpoints().apiBase,
      model,
      modelSelection: selection,
      modelInfo: provider.models[model],
      provider: 'openai',
      providerApi: 'responses',
      providerAuth: 'chatgpt',
    };
  }

  const baseUrl = provider.baseURL ?? provider.baseUrl ?? config.defaultBaseUrl ?? config.baseUrl;
  // A provider only the workspace declares sends its own key or none: the user's key does not
  // follow an origin the repository named, however the user came to approve the entry (#418).
  const apiKey = config.workspaceProviderGate?.declared.includes(providerId)
    ? (resolveSecret(provider.apiKey, config.workspace) ?? '')
    : (resolveSecret(provider.apiKey, config.workspace) ?? inheritedApiKey(config, baseUrl));
  return {
    ...config,
    apiKey,
    baseUrl,
    model,
    modelSelection: selection,
    modelInfo: provider.models[model],
    provider: provider.type,
    providerApi: provider.type === 'openai' ? provider.api : undefined,
    providerAuth: undefined,
  };
}

/**
 * The session's config once its provider registry changed mid-session: a `type: "chatgpt"`
 * provider saved by `/login`, or a provider removed. It carries the settings and gate a launch
 * would compute now, with the values derived from them recomputed: `compactModel` and
 * `advisorModel` (environment first, as at launch), and the session's model.
 *
 * A launch-time gate cannot withhold a selection naming a Sign in with ChatGPT provider that did
 * not exist yet. Without this, a repository's `compactModel`, `advisorModel`, profile `model`,
 * `model` or legacy `.bookrc.json` model naming one would resolve as the user's choice once
 * `/login` added the provider, and bill the user's plan (#615). The session's own model moves only
 * when a repository chose it and it now names a plan provider; the user's choices stay as they are.
 *
 * `settings` and `providerGate` are a fresh `resolveSettingsWithProviderGate` read, with the
 * environment's settings overrides already applied.
 */
export function regateSessionConfig(
  current: AgentConfig,
  settings: AgentConfig['settings'],
  providerGate: WorkspaceProviderGate,
  env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const selection = (current.modelSelection ?? current.model).trim();
  const legacyModel = parseLegacyConfig(current.workspace)?.model;
  // Only when nothing above the file names a model, as at launch: `--model` is not kept on the
  // config, so a session model equal to the file's value is read as having come from it.
  const legacyPlan =
    legacyModel !== undefined && !env.BOOK_MODEL && !settings.model
      ? withheldLegacyModelSelection({
          legacyModel,
          path: legacyConfigPath(current.workspace),
          withheldIds: new Set<string>(),
          planIds: chatGptProviderIds(settings.provider),
        })
      : undefined;
  const withheldSelections = legacyPlan
    ? [...providerGate.withheldSelections, legacyPlan]
    : providerGate.withheldSelections;
  const regated: AgentConfig = {
    ...current,
    settings,
    workspaceProviderGate: {
      ...providerGate,
      withheldSelections,
      legacyBaseUrl: current.workspaceProviderGate?.legacyBaseUrl,
    },
    compactModel: env.BOOK_COMPACT_MODEL || settings.compactModel,
    advisorModel: env.BOOK_ADVISOR_MODEL || settings.advisorModel,
  };
  const dropped = withheldSelections.find(
    (withheld) =>
      withheld.reason === 'plan' && withheld.key === 'model' && withheld.value.trim() === selection,
  );
  if (!dropped) return regated;
  return applyModelDefaults(
    resolveModelProviderConfig(regated, dropped.fallback ?? 'gpt-4o', { trustedSelection: true }),
  );
}

/**
 * The legacy `.bookrc.json` `model` as a withheld selection, when it must give way: it names a
 * withheld workspace provider, or the user's own Sign in with ChatGPT provider (#418, #615).
 */
export function withheldLegacyModelSelection(input: {
  legacyModel: string;
  path: string;
  withheldIds: ReadonlySet<string>;
  planIds: ReadonlySet<string>;
}): WithheldModelSelection | undefined {
  const prefix = providerPrefixOf(input.legacyModel);
  if (prefix === undefined) return undefined;
  const namesPlan = input.planIds.has(prefix);
  if (!namesPlan && !input.withheldIds.has(prefix)) return undefined;
  return {
    key: 'model',
    value: input.legacyModel,
    providerId: prefix,
    path: input.path,
    fallback: undefined,
    ...(namesPlan ? { reason: 'plan' as const } : {}),
  };
}

/**
 * Clamp an effort down to the highest level the model's catalog lists at or
 * below it. A catalog that disables effort gets none. A catalog entry without a
 * `levels` list, and a model without a catalog entry, keep the effort as asked;
 * an empty `levels` list exposes no choices, and gets none. When the catalog
 * lists no level at or below it, a defaulted effort gets none -- an unlisted
 * level is a 400 on a strict endpoint, and the clamp never goes back up -- while
 * `raiseToLowest` (a level someone chose) takes the lowest listed level instead,
 * the nearest the model offers to what was asked.
 */
export function clampEffortToCatalog(
  config: Pick<AgentConfig, 'model' | 'modelSelection' | 'modelInfo'>,
  effort: AgentConfig['effort'],
  options: { raiseToLowest?: boolean } = {},
): AgentConfig['effort'] {
  const levels = getAvailableEffortLevels(config);
  if (levels === null || effort === undefined) return undefined;
  const ceiling = EFFORT_LEVELS.indexOf(effort);
  const clamped = levels.filter((level) => EFFORT_LEVELS.indexOf(level) <= ceiling).at(-1);
  return clamped ?? (options.raiseToLowest ? levels[0] : undefined);
}

/**
 * The effort of a request on the compact model. A checkpoint does not need
 * minutes of reasoning, and at `--effort max` on a slow route the reducer's
 * request produced no byte for long enough that the proxy dropped it, ten times
 * over (#214). The target is
 * `compactEffort`, or else the session's effort capped at `medium`, clamped to
 * the compact model's catalog: it never falls back to the uncapped session effort.
 */
function compactModelEffort(config: AgentConfig): AgentConfig['effort'] {
  const cap = EFFORT_LEVELS.indexOf('medium');
  const target =
    config.compactEffort ??
    (config.effort && EFFORT_LEVELS.indexOf(config.effort) > cap ? 'medium' : config.effort);
  // An explicit `compactEffort` is a choice for this model: below every listed level it takes the
  // lowest one. The session's capped effort never goes back up.
  return clampEffortToCatalog(config, target, {
    raiseToLowest: config.compactEffort !== undefined,
  });
}

/**
 * Whether a request sends its effort: the `effortExplicit` flag, which is what
 * makes the OpenAI-compatible path send `reasoning_effort`. A strict endpoint
 * answers an effort for a model that does not reason with a 400 that is not
 * retried, so a request sends one only when a level was chosen for it, or when
 * its model's catalog lists that level. With neither -- the default `gpt-4o`, or
 * any model without a catalog entry -- it carries none, like the main agent's.
 * Every request on the compact model, and every managed child, decides by this
 * one rule. A catalog entry without a `levels` list that names a `default` says
 * the model takes an effort, and lists every level, as `getAvailableEffortLevels`
 * and `/effort` read it; an entry that names neither (`effort: {}`) lists none.
 */
export function resolveEffortExplicit(
  config: Pick<AgentConfig, 'modelInfo'>,
  effort: AgentConfig['effort'],
  chosen: boolean,
): boolean {
  if (effort === undefined) return false;
  if (chosen) return true;
  const catalog = config.modelInfo?.effort;
  if (typeof catalog !== 'object') return false;
  return catalog.levels ? catalog.levels.includes(effort) : catalog.default !== undefined;
}

/**
 * True when compaction runs on the session's own model rather than a distinct
 * compact model: no compact model is configured, or it matches the session's
 * model selection or bare model name.
 */
export function compactsOnSessionModel(
  config: Pick<AgentConfig, 'compactModel' | 'settings' | 'model' | 'modelSelection'>,
): boolean {
  const compactModel = config.compactModel?.trim() || config.settings?.compactModel?.trim();
  return !compactModel || compactModel === config.modelSelection || compactModel === config.model;
}

/**
 * The compact model's config, for every request made on it: the compaction
 * reducer and the deferred-compaction judge. It is routed to
 * `compactModel` when one is set, without changing the active agent model, and
 * carries the capped, catalog-clamped effort of `compactModelEffort`. It keeps
 * the session's retry policy; the reducer and the judge add their retry caps
 * through `resolveReducerModelConfig`.
 */
export function resolveCompactModelConfig(config: AgentConfig): AgentConfig {
  const compactModel = config.compactModel?.trim() || config.settings.compactModel?.trim();
  const resolved = compactsOnSessionModel(config)
    ? config
    : applyModelDefaults(
        resolveModelProviderConfig(config, compactModel!, { trustedSelection: true }),
      );
  const effort = compactModelEffort(resolved);
  // A level was chosen by `compactEffort` or for the session. A level a managed child's catalog
  // merely listed is sent to the child's model, but is not a choice the compact model inherits.
  const chosen = resolved.compactEffort !== undefined || isEffortChosen(resolved);
  return {
    ...resolved,
    effort,
    effortChosen: chosen,
    effortExplicit: resolveEffortExplicit(resolved, effort, chosen),
  };
}

/**
 * The advisor model the session is configured with, if any. {@link ADVISOR_OFF_VALUE} is "none":
 * it is what `/advisor off` writes when a layer it cannot edit still declares an advisor.
 */
export function configuredAdvisorModel(
  config: Pick<AgentConfig, 'advisorModel' | 'settings'>,
): string | undefined {
  const configured =
    config.advisorModel?.trim() || config.settings?.advisorModel?.trim() || undefined;
  return configured?.toLowerCase() === ADVISOR_OFF_VALUE ? undefined : configured;
}

/**
 * Why `advisorModel` may not be sent a request, or `undefined` when it may. The advisor
 * is a request the user did not make this turn, so it fails closed: an id that is not
 * `<provider>/<model>` for a provider in `settings.provider` resolves against the default
 * endpoint with whichever key is lying around, and that was the user's Anthropic key
 * going to api.openai.com on every consult (#419). Such an id is allowed only when:
 *
 * 1. it is the main model;
 * 2. BOOK_BASE_URL is set, so the default endpoint is the one the user chose. Only the
 *    environment counts: the legacy `.bookrc.json` `baseUrl` ships with a repository and
 *    does not say what the user chose; or
 * 3. it resolves to the very endpoint (compared after `sameEndpoint` normalisation) and key
 *    the main session already uses, so the request reaches no host that is not already
 *    receiving that key every turn.
 *
 * An id that starts or ends with `/` is refused first, whatever the base URL: it is no model
 * id, and resolving it throws.
 *
 * `config` is the main session's config.
 */
export function advisorModelRefusal(config: AgentConfig, advisorModel: string): string | undefined {
  const id = advisorModel.trim();
  if (id.startsWith('/') || id.endsWith('/')) {
    return `advisor model "${id}" is not a model id; use <provider>/<model>`;
  }
  const slash = id.indexOf('/');
  if (id === config.modelSelection || id === config.model) return undefined;
  const providers = config.settings.provider;
  if (slash > 0 && Object.hasOwn(providers, id.slice(0, slash))) return undefined;
  if (config.defaultBaseUrlExplicit) return undefined;
  // The advisor id is the user's own selection (the loader replaced a workspace one naming a
  // withheld provider), so a prefix that names one resolves as the plain fallback and meets the
  // check below like any other unconfigured prefix (#418).
  const resolved = resolveModelProviderConfig(config, id, { trustedSelection: true });
  if (sameEndpoint(resolved.baseUrl, config.baseUrl) && resolved.apiKey === config.apiKey) {
    return undefined;
  }
  const configured = Object.keys(providers).sort();
  return (
    `advisor model "${id}" names no configured provider, so its key and endpoint are ambiguous; ` +
    `use <provider>/<model>${configured.length ? ` (configured: ${configured.join(', ')})` : ''}`
  );
}

/**
 * The config for a request on the advisor model (`tools/advisor.ts`), or
 * `undefined` when none is configured. Routed like the compact model -- the
 * selection may name another provider -- and it keeps the session's effort up to
 * `high`, clamped to the advisor's catalog: the advisor is consulted for judgment,
 * so it is not capped at `medium` the way the reducer is.
 */
export function resolveAdvisorModelConfig(config: AgentConfig): AgentConfig | undefined {
  const advisorModel = configuredAdvisorModel(config);
  if (!advisorModel) return undefined;
  const resolved =
    advisorModel === config.modelSelection || advisorModel === config.model
      ? config
      : applyModelDefaults(
          resolveModelProviderConfig(config, advisorModel, { trustedSelection: true }),
        );
  // Up to `high`: at `xhigh` or `max` a thinking advisor can spend its whole output cap
  // reasoning and hand back no advice at all.
  const capped =
    resolved.effort && EFFORT_LEVELS.indexOf(resolved.effort) > EFFORT_LEVELS.indexOf('high')
      ? 'high'
      : resolved.effort;
  const effort = clampEffortToCatalog(resolved, capped);
  const chosen = isEffortChosen(resolved);
  return {
    ...resolved,
    effort,
    effortChosen: chosen,
    effortExplicit: resolveEffortExplicit(resolved, effort, chosen),
  };
}

/**
 * The reducer's and the judge's config: the compact model's, retried at most
 * twice with the watchdog off. Both fall back when the model path fails -- the
 * reducer to the deterministic checkpoint, the judge to an inconclusive verdict
 * that commits the checkpoint anyway -- so more attempts only delay that.
 */
export function resolveReducerModelConfig(config: AgentConfig): AgentConfig {
  const resolved = resolveCompactModelConfig(config);
  return {
    ...resolved,
    // A reducer request that dies before its first byte twice is not going to succeed
    // at that size, and runCompaction already falls back to the deterministic
    // checkpoint when the model path fails — ten attempts at five minutes each only
    // delayed that fallback. The watchdog retries 429/529 without limit, which
    // would lift this cap, so it is off for the reducer.
    retry: {
      ...resolved.retry,
      maxAttempts: Math.min(resolved.retry.maxAttempts, 2),
      watchdog: false,
    },
  };
}

/**
 * Read a key a settings file wrote as a literal, `{env:VAR}` or `{file:path}`.
 *
 * A workspace layer can carry a reference, so a caller must only hand this a declaration the user
 * has accepted (#418). The audit of every caller: `resolveModelProviderConfig` reads
 * `settings.provider`, which holds trusted-layer providers and approved workspace ones only (a
 * pending or rejected one is absent and its model id throws first); and the model picker's
 * refresh reads the same resolved map; and `checkProviderKey` (`provider-key.ts`) resolves only the
 * key the user just typed into `/model`'s key sheet or `book config provider-key`'s stdin, never
 * one read from a file. Nothing else resolves a reference: project MCP servers
 * expand their own `${VAR}` syntax behind `mcp-approvals.ts`, and hook `env` values are literals
 * behind `hook-approvals.ts`.
 */
export function resolveSecret(raw: string | undefined, workspace: string): string | undefined {
  if (!raw) return undefined;
  const reference = parseSecretReference(raw);
  if (reference.kind === 'env') return process.env[reference.name];
  if (reference.kind === 'literal') return raw;

  const file = resolveSecretFilePath(reference.path, workspace);
  if (!file.readable) return undefined;

  try {
    return readFileSync(file.path, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

function validateEffort(raw: string | undefined): AgentConfig['effort'] {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return isEffortLevel(normalized) ? normalized : undefined;
}

const VALID_PROVIDERS = new Set(['anthropic', 'openai', 'auto']);

function validateProvider(raw: string | undefined): AgentConfig['provider'] {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return VALID_PROVIDERS.has(normalized) ? (normalized as AgentConfig['provider']) : undefined;
}

function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function parsePositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

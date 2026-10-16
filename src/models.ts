/**
 * Advisory list of switchable models for the /model picker.
 *
 * Book is provider-agnostic; this list is advisory only, used to populate the
 * picker. `/model <any-string>` still bypasses it for unlisted models. There
 * is no capability query — unknown models are allowed and left to the provider.
 *
 * `effort` marks models that accept an effort level (Anthropic adaptive
 * thinking); others ignore it.
 */
import type { AgentConfig } from './types/runtime.js';
import type { ContextWindowSource } from './types/messages.js';
import type { ModelWindowStore } from './model-window-store.js';

export type { ContextWindowSource, ModelWindowStore };

export interface ModelOption {
  id: string;
  /** Short label shown in the picker. */
  label: string;
  provider: 'anthropic' | 'openai' | 'z-ai';
  /** Supports the effort axis (low/medium/high/xhigh/max). */
  effort?: boolean;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', effort: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', effort: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'anthropic', effort: true },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic', effort: true },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', effort: true },
  { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', effort: true },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', effort: true },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic', effort: true },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    effort: true,
  },
  { id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'anthropic', effort: true },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-5', label: 'GPT-5', provider: 'openai' },
  { id: 'glm-4.6', label: 'GLM 4.6', provider: 'z-ai' },
  { id: 'z-ai/glm-5.2', label: 'GLM 5.2', provider: 'z-ai' },
];

/**
 * Cheap: whether the active model accepts an effort axis (used by the picker).
 * Falls back to true on unknown models so effort remains tweakable.
 */
export function modelSupportsEffort(model: string): boolean {
  const found = AVAILABLE_MODELS.find((m) => m.id === model);
  return found ? Boolean(found.effort) : true;
}

/** Mutation-tool preference rendered into the system prompt guidance. */
export type EditFormat = 'patch' | 'replace' | 'whole';

/**
 * Built-in mutation-format prior by model family. GPT/Codex-family models are
 * trained on the V4A patch envelope (ApplyPatch); everything else — Claude,
 * Qwen, GLM, Gemini, Grok, and unknown models — is safest with exact-replace
 * editing (Edit/MultiEdit). Known picker models use their provider metadata;
 * unknown ids fall back to a deliberately narrow family pattern (community
 * models like gpt-j / gpt-neox merely contain "gpt" and must stay on replace).
 * Per-model overrides belong in settings
 * (provider.<name>.models.<id>.editFormat), never in this table.
 */
export function editFormatFor(model: string): EditFormat {
  const known = AVAILABLE_MODELS.find((m) => m.id === model);
  if (known) return known.provider === 'openai' ? 'patch' : 'replace';
  const family = model.split('/').pop()?.toLowerCase() ?? '';
  return /^(gpt-\d|gpt-oss|chatgpt|codex|o\d)(?![a-z])/.test(family) ? 'patch' : 'replace';
}

/** Settings override wins; otherwise the family prior. */
export function resolveEditFormat(model: string, override?: EditFormat): EditFormat {
  return override ?? editFormatFor(model);
}

/**
 * Context window assumed for a model that declares none.
 *
 * Every consumer of "how big is this model's window" must resolve it through
 * resolveContextLimit() below. Three sites once carried three different
 * fallbacks (272k, 100k, and a max-*output*-token budget), so /context, the
 * status bar, and compaction disagreed about the same number in one session.
 */
export const DEFAULT_CONTEXT_WINDOW = 272_000;

/**
 * Strips provider and routing prefixes from a model name for display,
 * keeping the model's terminal identifier and original casing
 * (e.g. `9router/ag/gemini-3.8-flash-high` -> `gemini-3.8-flash-high`,
 * `openai/gpt-4o` -> `gpt-4o`, `claude-opus-5` -> `claude-opus-5`).
 */
export function stripProvider(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return '';
  const last = trimmed.split('/').pop()?.trim();
  return last || trimmed;
}

/**
 * Normalizes a model identifier by extracting the terminal model name and
 * stripping version/date stamps (e.g. `9router/ag/gemini-3.8-flash-high` ->
 * `gemini-3.8-flash-high`, `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`).
 */
export function normalizeModelName(model: string): string {
  const last = model.split('/').pop()?.toLowerCase().trim() ?? '';
  return last.replace(/[-.@]\d{4}-?\d{2}-?\d{2}$|[-.@]\d{8}$/, '');
}

/**
 * Advisory context window table by model family.
 *
 * Sizing rule: a family value that is too LARGE is worse than falling back to
 * DEFAULT_CONTEXT_WINDOW, because compaction would not fire in time and the
 * run would hit a provider refusal followed by overflow compaction. When a
 * family has variants, use the SMALLER published window. Unknown models fall
 * through to DEFAULT_CONTEXT_WINDOW.
 *
 * RE-VERIFY against published documentation before a release.
 */
export const MODEL_FAMILY_CONTEXT_WINDOWS: ReadonlyArray<{
  family: string;
  pattern: RegExp;
  contextWindow: number;
}> = [
  // Google Gemini Flash family: 1,048,576 tokens (1M).
  // 1.5 Flash, 2.0 Flash, 2.5 Flash, 3.x Flash all publish 1,048,576 input tokens.
  {
    family: 'gemini-flash',
    pattern: /^gemini(?!.*-(?:image|tts)).*flash/,
    contextWindow: 1_048_576,
  },
  // Anthropic Claude 4.6 and later: 1,000,000 tokens, the default with no beta header
  // (`max_input_tokens` from /v1/models, #416). Opus/Sonnet 4.6+, and every 5.x tier:
  // Opus 5/5.5, Sonnet 5/5.5, Haiku 5.5, Fable 5/5.1, Mythos 5/5.1. The minor version
  // takes `-` or `.` (`claude-opus-4.6` on routers), and `(?!\d)` keeps a version
  // from matching the front of a longer number. Must precede the 200k row below,
  // which catches everything older.
  {
    family: 'claude-1m',
    pattern:
      /^claude-(?:(?:opus|sonnet|haiku|fable|mythos)-[5-9]|(?:opus|sonnet)-4[-.][6-9])(?!\d)/,
    contextWindow: 1_000_000,
  },
  // Anthropic Claude 3 through 4.5: 200,000 tokens.
  // Haiku 4.5, Sonnet/Opus 4.5, Opus 4.1, Opus/Sonnet 4, Claude 3.x, Mythos Preview.
  {
    family: 'claude',
    pattern: /^claude-(?:[3-9]|opus|sonnet|haiku|fable|mythos)/,
    contextWindow: 200_000,
  },
  // OpenAI GPT-4o / GPT-4o-mini: 128,000 tokens.
  {
    family: 'gpt-4o',
    pattern: /^gpt-4o/,
    contextWindow: 128_000,
  },
  // OpenAI GPT-4 Turbo: 128,000 tokens.
  {
    family: 'gpt-4-turbo',
    pattern: /^gpt-4-turbo|^gpt-4-\d{4}-preview/,
    contextWindow: 128_000,
  },
  // OpenAI o-series reasoning models (o1, o3, o4): 128,000 tokens.
  // Using the smaller 128k baseline (o1-preview / o1-mini) per the sizing rule.
  {
    family: 'o-series',
    pattern: /^o[134](?:-mini|-preview)?(?![a-z\d])/,
    contextWindow: 128_000,
  },
  // OpenAI GPT-4 32k: 32,768 tokens.
  {
    family: 'gpt-4-32k',
    pattern: /^gpt-4-32k/,
    contextWindow: 32_768,
  },
  // OpenAI GPT-4 (original 8k base models): 8,192 tokens.
  // Gated so it does not match gpt-4o, gpt-4-turbo, or gpt-4-32k defined above.
  {
    family: 'gpt-4',
    pattern: /^gpt-4(?![a-z\d])/,
    contextWindow: 8_192,
  },
  // OpenAI GPT-3.5 Turbo: 16,385 tokens.
  {
    family: 'gpt-3.5-turbo',
    pattern: /^gpt-3\.5-turbo/,
    contextWindow: 16_385,
  },
  // Note: Qwen (e.g. Qwen 2.5) was deliberately excluded. Its published context window
  // spans 32k (native context in common local deployments without YaRN rope scaling)
  // to 1M (Turbo/1M variants), so no single family-level value is safe. It falls
  // through to DEFAULT_CONTEXT_WINDOW with source: 'default', prompting explicit configuration.
];

/**
 * Resolve a model string against known model families.
 */
export function resolveFamilyContextWindow(model: string): number | undefined {
  const normalized = normalizeModelName(model);
  if (!normalized) return undefined;
  for (const entry of MODEL_FAMILY_CONTEXT_WINDOWS) {
    if (entry.pattern.test(normalized)) {
      return entry.contextWindow;
    }
  }
  return undefined;
}

export interface ContextWindowResolution {
  window: number;
  source: ContextWindowSource;
}

/**
 * Derive the model key for context window resolution and ratchet storage.
 *
 * Precedence: modelSelection (e.g. configured or overridden model string) -> model.
 * Used consistently for learned store reads, family pattern matching, and learned
 * store ratchet writes (#186).
 */
export function resolveModelKey(
  config: Partial<Pick<AgentConfig, 'model' | 'modelSelection'>>,
): string | undefined {
  return config.modelSelection ?? config.model;
}

/**
 * Resolve the context window and its origin for a model.
 * Precedence: declared (`config.modelInfo?.contextWindow`) -> learned (from overflow store) ->
 * reported (`config.modelInfo?.reportedContextWindow`, from the endpoint's model list) -> family
 * match -> DEFAULT_CONTEXT_WINDOW.
 */
export function resolveContextWindow(
  config: Pick<AgentConfig, 'modelInfo'> &
    Partial<Pick<AgentConfig, 'model' | 'modelSelection' | 'modelWindowStore'>>,
  store?: ModelWindowStore,
): ContextWindowResolution {
  const declared = config.modelInfo?.contextWindow;
  if (typeof declared === 'number' && declared > 0) {
    return { window: declared, source: 'declared' };
  }
  const effectiveStore = store ?? config.modelWindowStore;
  const modelKey = resolveModelKey(config);
  if (modelKey && effectiveStore) {
    const learnedWindow = effectiveStore.get(modelKey);
    if (typeof learnedWindow === 'number' && learnedWindow > 0) {
      return { window: learnedWindow, source: 'learned' };
    }
  }
  const reported = config.modelInfo?.reportedContextWindow;
  if (typeof reported === 'number' && reported > 0) {
    return { window: reported, source: 'reported' };
  }
  if (modelKey) {
    const familyWindow = resolveFamilyContextWindow(modelKey);
    if (familyWindow !== undefined) {
      return { window: familyWindow, source: 'family' };
    }
  }
  return { window: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

/**
 * The context window to act on: what the model declares, else learned, else the endpoint's
 * reported window, else family, else default.
 */
export function resolveContextLimit(
  config: Pick<AgentConfig, 'modelInfo'> &
    Partial<Pick<AgentConfig, 'model' | 'modelSelection' | 'modelWindowStore'>>,
  store?: ModelWindowStore,
): number {
  return resolveContextWindow(config, store).window;
}

/**
 * True when the window was explicitly declared in config.modelInfo. A reported window is not a
 * declaration: it can be wrong, so the overflow ratchet must still be able to learn a lower one.
 */
export function hasDeclaredContextWindow(
  config: Partial<Pick<AgentConfig, 'modelInfo' | 'model' | 'modelSelection' | 'modelWindowStore'>>,
): boolean {
  const declared = config.modelInfo?.contextWindow;
  return typeof declared === 'number' && declared > 0;
}

/**
 * How capable a Claude model is as an advisor, higher is stronger: Claude Code's
 * advisor ranking. Only models in this table are compared; for any other id the
 * rank is unknown and `/advisor` says nothing about relative strength.
 */
// `(?!-\d(?!\d))` refuses a one-digit minor version after the major one, so
// `opus-5` does not swallow `opus-5-1`, while a dated id (`opus-5-20261001`) still matches.
const ADVISOR_RANKS: ReadonlyArray<[RegExp, number]> = [
  [/(?:fable|mythos)-5-1\b/, 9],
  [/(?:fable|mythos)-5(?!-\d(?!\d))\b/, 8],
  [/opus-5(?:-5)?(?!-\d(?!\d))\b/, 7],
  [/sonnet-5-5\b/, 6],
  [/opus-4-[78]\b/, 5],
  [/(?:haiku-5-5|sonnet-5(?!-\d(?!\d)))\b/, 4],
  [/opus-4-6\b/, 3],
  [/sonnet-4-6\b/, 2],
  [/haiku-4-5\b/, 1],
];

export function advisorRank(model: string): number | undefined {
  const id = model.toLowerCase();
  return ADVISOR_RANKS.find(([pattern]) => pattern.test(id))?.[1];
}

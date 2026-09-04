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

export type { ContextWindowSource };

export interface ModelOption {
  id: string;
  /** Short label shown in the picker. */
  label: string;
  provider: 'anthropic' | 'openai' | 'z-ai';
  /** Supports the effort axis (low/medium/high/xhigh/max). */
  effort?: boolean;
}

export const AVAILABLE_MODELS: ModelOption[] = [
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
  // Anthropic Claude 3+ family: 200,000 tokens published standard context.
  // Sonnet 3.5/5, Opus 3/4.x/5, Haiku 3.5/4.5, Fable 5.
  {
    family: 'claude',
    pattern: /^claude-(?:[3-9]|opus|sonnet|haiku|fable)/,
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
 * Resolve the context window and its origin for a model.
 * Precedence: declared (`config.modelInfo?.contextWindow`) -> family match -> DEFAULT_CONTEXT_WINDOW.
 */
export function resolveContextWindow(
  config: Pick<AgentConfig, 'modelInfo'> & Partial<Pick<AgentConfig, 'model' | 'modelSelection'>>,
): ContextWindowResolution {
  const declared = config.modelInfo?.contextWindow;
  if (typeof declared === 'number' && declared > 0) {
    return { window: declared, source: 'declared' };
  }
  const modelName = config.model ?? config.modelSelection;
  if (modelName) {
    const familyWindow = resolveFamilyContextWindow(modelName);
    if (familyWindow !== undefined) {
      return { window: familyWindow, source: 'family' };
    }
  }
  return { window: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

/** The context window to act on: what the model declares, else family, else default. */
export function resolveContextLimit(
  config: Pick<AgentConfig, 'modelInfo'> & Partial<Pick<AgentConfig, 'model' | 'modelSelection'>>,
): number {
  return resolveContextWindow(config).window;
}

/** True when the window above came from the model rather than the default. */
export function hasDeclaredContextWindow(config: Pick<AgentConfig, 'modelInfo'>): boolean {
  return resolveContextWindow(config).source === 'declared';
}

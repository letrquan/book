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

/** The context window to act on: what the model declares, else the default. */
export function resolveContextLimit(config: Pick<AgentConfig, 'modelInfo'>): number {
  const window = config.modelInfo?.contextWindow;
  return typeof window === 'number' && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
}

/** True when the window above came from the model rather than the default. */
export function hasDeclaredContextWindow(config: Pick<AgentConfig, 'modelInfo'>): boolean {
  const window = config.modelInfo?.contextWindow;
  return typeof window === 'number' && window > 0;
}

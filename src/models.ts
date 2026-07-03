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
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', effort: true },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic', effort: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic', effort: true },
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

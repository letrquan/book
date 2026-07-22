import type { ResolvedSettings } from './settings.js';
import { type MemoryCandidate, writeMemoryCandidate } from './memory-store.js';
import { looksLikeSecretOrUnfit } from './secret-detect.js';

interface DetectInput {
  userMessage: string;
  previousAssistant?: string;
}

interface CaptureInput extends DetectInput {
  workspace: string;
  settings: ResolvedSettings;
}

export interface MemoryCaptureResult {
  saved: boolean;
  path?: string;
  reason?: string;
  candidate?: MemoryCandidate;
}

const MAX_BODY_CHARS = 1600;

export function shouldRejectMemoryText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.length > MAX_BODY_CHARS * 2) return 'too long';
  return looksLikeSecretOrUnfit(trimmed);
}

function sentenceCaseTitle(text: string): string {
  const cleaned = text
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '');
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned || 'Memory candidate';
}

function classify(text: string): MemoryCandidate['type'] {
  const lower = text.toLowerCase();
  if (/https?:\/\//.test(text) || /\breference\b|\bdocs?\b|\bdashboard\b|\bticket\b/.test(lower)) {
    return 'reference';
  }
  if (
    /\b(this repo|this project|in book|for book|we use|the convention|project convention|codebase)\b/.test(
      lower,
    )
  ) {
    return 'project';
  }
  if (/\b(i prefer|my preference|call me|i am|my name|i like|i don't like)\b/.test(lower)) {
    return 'user';
  }
  return 'feedback';
}

function stripTrigger(text: string): string {
  return text
    .replace(/^\s*(please\s+)?remember\s+(that\s+)?/i, '')
    .replace(/^\s*for future reference[:,]?\s*/i, '')
    .replace(/^\s*from now on[:,]?\s*/i, '')
    .replace(/^\s*correction[:,]?\s*/i, '')
    .replace(/^\s*actually[:,]?\s*/i, '')
    .replace(/^\s*no,?\s+that'?s wrong[:,]?\s*/i, '')
    .replace(/^\s*i meant[:,]?\s*/i, '')
    .trim();
}

export function detectMemoryCandidate(input: DetectInput): MemoryCandidate | null {
  const raw = input.userMessage.trim();
  if (/^(ok|okay|yes|yep|thanks|thank you|sounds good|great|cool)[.!\s]*$/i.test(raw)) return null;

  const explicit =
    /^(please\s+)?remember\s+(that\s+)?/i.test(raw) ||
    /^for future reference[:,]?/i.test(raw) ||
    /^from now on[:,]?/i.test(raw);
  const correction =
    /^correction[:,]?/i.test(raw) ||
    /^actually[:,]?/i.test(raw) ||
    /^no,?\s+that'?s wrong/i.test(raw) ||
    /^i meant[:,]?/i.test(raw);
  const confirmation =
    /\b(that worked|that fixed it|use that approach|that'?s the convention|yes, use that)\b/i.test(
      raw,
    );

  if (!explicit && !correction && !(confirmation && input.previousAssistant)) return null;

  const bodyCore = stripTrigger(raw);
  const prior =
    confirmation && input.previousAssistant
      ? `\n\nPrior assistant context: ${input.previousAssistant.replace(/\s+/g, ' ').slice(0, 240)}`
      : '';
  const body =
    `${correction ? 'User correction: ' : confirmation ? 'User confirmation: ' : ''}${bodyCore}${prior}`
      .trim()
      .slice(0, MAX_BODY_CHARS);
  const reject = shouldRejectMemoryText(body);
  if (reject) return null;

  return {
    type: classify(body),
    title: sentenceCaseTitle(bodyCore),
    body,
    source: 'auto',
    confidence: explicit || correction ? 'high' : 'medium',
    tags: [explicit ? 'explicit' : correction ? 'correction' : 'confirmation'],
  };
}

export function maybeCaptureMemoryCandidate(input: CaptureInput): MemoryCaptureResult {
  if (!input.settings.memory.enabled) return { saved: false, reason: 'memory disabled' };
  if (!input.settings.memory.autoSave) return { saved: false, reason: 'auto-capture disabled' };

  const candidate = detectMemoryCandidate(input);
  if (!candidate) return { saved: false, reason: 'no durable memory candidate' };

  const reject = shouldRejectMemoryText(`${candidate.title}\n${candidate.body}`);
  if (reject) return { saved: false, reason: reject, candidate };

  const result = writeMemoryCandidate(input.workspace, candidate);
  if (!result.ok) return { saved: false, reason: result.error, candidate };
  return { saved: true, path: result.path, candidate };
}

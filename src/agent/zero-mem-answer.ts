import type { ZeroMemAnswerType, ZeroMemEvidence, ZeroMemProfile } from './zero-mem.js';

export interface ZeroMemAnswerCalibration {
  initialAnswer: string;
  answer: string;
  output: string;
  changed: boolean;
  supported: boolean;
  formatCompliant: boolean;
  reason: 'supported' | 'format-normalized' | 'unique-candidate' | 'list-pruned' | 'unchanged';
  candidates: string[];
}

const HISTORICAL_MARKERS = [
  'historical',
  'superseded',
  'rejected',
  'wrong',
  'no longer',
  'earlier',
  'initial',
];

const CURRENT_CUES = ['current', 'currently', 'latest', 'now', 'active'];
const UNKNOWN_MARKERS = [
  'unknown',
  'not recorded',
  'not provided',
  'not available',
  'cannot determine',
];

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function parseAnswer(rawOutput: string): { answer: string; formatCompliant: boolean } {
  const candidate = rawOutput.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as { answer?: unknown; value?: unknown };
      const answer = parsed.answer ?? parsed.value;
      if (typeof answer === 'string') return { answer: answer.trim(), formatCompliant: true };
    } catch {
      // Fall through to the raw answer so deterministic calibration can still operate.
    }
  }
  return { answer: rawOutput.trim(), formatCompliant: false };
}

function isCurrentProfile(profile: ZeroMemProfile): boolean {
  return profile.temporalCues.some((cue) => CURRENT_CUES.includes(cue));
}

function clauseAt(text: string, start: number, end: number): string {
  const left = Math.max(
    text.lastIndexOf('.', start - 1),
    text.lastIndexOf(';', start - 1),
    text.lastIndexOf('\n', start - 1),
  );
  const endings = [text.indexOf('.', end), text.indexOf(';', end), text.indexOf('\n', end)].filter(
    (index) => index >= 0,
  );
  const right = endings.length > 0 ? Math.min(...endings) : text.length;
  return text.slice(left + 1, right);
}

function isHistoricalOccurrence(text: string, start: number, end: number): boolean {
  const clause = normalize(clauseAt(text, start, end));
  return HISTORICAL_MARKERS.some((marker) => clause.includes(marker));
}

function answerSupported(
  answer: string,
  evidenceText: string,
  profile: ZeroMemProfile,
  evidenceCount: number,
): boolean {
  const normalizedAnswer = normalize(answer);
  if (!normalizedAnswer) return false;
  if (evidenceCount === 0 && UNKNOWN_MARKERS.some((marker) => normalizedAnswer.includes(marker))) {
    return true;
  }
  const normalizedEvidence = normalize(evidenceText);
  let offset = 0;
  while (offset < normalizedEvidence.length) {
    const found = normalizedEvidence.indexOf(normalizedAnswer, offset);
    if (found < 0) break;
    if (
      !isCurrentProfile(profile) ||
      !isHistoricalOccurrence(normalizedEvidence, found, found + normalizedAnswer.length)
    ) {
      return true;
    }
    offset = found + Math.max(1, normalizedAnswer.length);
  }
  return false;
}

function addMatches(
  target: Map<string, string>,
  text: string,
  pattern: RegExp,
  profile: ZeroMemProfile,
): void {
  for (const match of text.matchAll(pattern)) {
    const value = (match[1] ?? match[0]).trim().replace(/^['"`]+|['"`]+$/g, '');
    if (!value) continue;
    const start = match.index + match[0].indexOf(match[1] ?? match[0]);
    const end = start + value.length;
    if (isCurrentProfile(profile) && isHistoricalOccurrence(text, start, end)) continue;
    target.set(normalize(value), value);
  }
}

function extractCandidates(
  answerType: ZeroMemAnswerType,
  evidenceText: string,
  profile: ZeroMemProfile,
): string[] {
  const candidates = new Map<string, string>();
  if (answerType === 'boolean') {
    addMatches(
      candidates,
      evidenceText,
      /\b(no longer active|not active|inactive|active now|active|yes|no|true|false)\b/gi,
      profile,
    );
  } else if (answerType === 'date') {
    addMatches(
      candidates,
      evidenceText,
      /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{4}-\d{2}-\d{2})\b/gi,
      profile,
    );
  } else if (answerType === 'number') {
    addMatches(
      candidates,
      evidenceText,
      /\b(v?\d+(?:\.\d+)*(?:\s*(?:milliseconds?|seconds?|minutes?|hours?|bytes?|percent))?)\b/gi,
      profile,
    );
  } else if (answerType === 'entity') {
    addMatches(
      candidates,
      evidenceText,
      /\b([A-Za-z][A-Za-z0-9]*(?:[._:/()-][A-Za-z0-9]+)+)\b/g,
      profile,
    );
    addMatches(candidates, evidenceText, /[`"']([^`"'\n]{2,80})[`"']/g, profile);
  }
  return [...candidates.values()];
}

function splitList(answer: string): string[] {
  return answer
    .split(/\s*(?:,|;|\band\b)\s*/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatOutput(query: string, answer: string): string {
  return /^Return JSON only\b/i.test(query.trim()) ? JSON.stringify({ answer }) : answer;
}

function deterministicCandidate(candidates: string[], profile: ZeroMemProfile): string | undefined {
  if (candidates.length === 1) return candidates[0];
  if (profile.answerType === 'date' && candidates.length > 1) {
    if (profile.temporalCues.some((cue) => ['first', 'earliest'].includes(cue))) {
      return candidates[0];
    }
    if (profile.temporalCues.some((cue) => ['current', 'latest', 'now'].includes(cue))) {
      return candidates.at(-1);
    }
  }
  return undefined;
}

export function calibrateZeroMemAnswer(
  rawOutput: string,
  query: string,
  evidence: readonly ZeroMemEvidence[],
  profile: ZeroMemProfile,
): ZeroMemAnswerCalibration {
  const parsed = parseAnswer(rawOutput);
  const evidenceText = evidence.map((item) => item.text).join('\n');
  const candidates = extractCandidates(profile.answerType, evidenceText, profile);
  const normalizedAnswer = normalize(parsed.answer);
  const candidateSupported =
    profile.answerType === 'boolean' ||
    profile.answerType === 'date' ||
    profile.answerType === 'entity'
      ? candidates.some((candidate) => normalizedAnswer.includes(normalize(candidate)))
      : false;
  const supported =
    answerSupported(parsed.answer, evidenceText, profile, evidence.length) || candidateSupported;
  let answer = parsed.answer;
  let reason: ZeroMemAnswerCalibration['reason'] = 'unchanged';

  if (profile.answerType === 'list' && answer) {
    const items = splitList(answer);
    const retained = items.filter((item) =>
      answerSupported(item, evidenceText, profile, evidence.length),
    );
    if (retained.length > 0 && retained.length < items.length) {
      answer = retained.join(', ');
      reason = 'list-pruned';
    }
  } else if (!supported) {
    const replacement = deterministicCandidate(candidates, profile);
    if (replacement) {
      answer = replacement;
      reason = 'unique-candidate';
    }
  }

  if (reason === 'unchanged') {
    if (supported && parsed.formatCompliant) reason = 'supported';
    else if (supported && !parsed.formatCompliant) reason = 'format-normalized';
  }
  const output = formatOutput(query, answer);
  return {
    initialAnswer: parsed.answer,
    answer,
    output,
    changed: output.trim() !== rawOutput.trim(),
    supported,
    formatCompliant: parsed.formatCompliant,
    reason,
    candidates,
  };
}

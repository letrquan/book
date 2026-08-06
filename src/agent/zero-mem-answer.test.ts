import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import type { ZeroMemEvidence, ZeroMemProfile } from './zero-mem.js';
import { calibrateZeroMemAnswer } from './zero-mem-answer.js';

function evidence(text: string): ZeroMemEvidence {
  const message: Message = {
    id: 'evidence',
    role: 'assistant',
    content: text,
    includeInContext: true,
    kind: 'conversation',
    timestamp: 1,
  };
  return {
    message,
    text,
    score: 1,
    graphScore: 1,
    hierarchyScore: 1,
    reasons: [],
    episode: 0,
  };
}

function profile(answerType: ZeroMemProfile['answerType']): ZeroMemProfile {
  return {
    subject: ['staging', 'region'],
    keywords: ['staging', 'region'],
    answerType,
    temporalCues: ['current', 'now'],
    route: 'local',
  };
}

describe('Zero-Mem answer calibration', () => {
  it('replaces an unsupported historical scalar with a unique current candidate', () => {
    const result = calibrateZeroMemAnswer(
      '{"answer":"us-east-1"}',
      'Return JSON only as {"answer":"..."}. What is the current staging region?',
      [evidence('Current staging is eu-west-1. us-east-1 is historical only.')],
      profile('entity'),
    );

    expect(result.answer).toBe('eu-west-1');
    expect(result.reason).toBe('unique-candidate');
    expect(JSON.parse(result.output)).toEqual({ answer: 'eu-west-1' });
  });

  it('normalizes supported output into the required format', () => {
    const result = calibrateZeroMemAnswer(
      'eu-west-1',
      'Return JSON only as {"answer":"..."}. What is the current staging region?',
      [evidence('Current staging is eu-west-1.')],
      profile('entity'),
    );

    expect(result.answer).toBe('eu-west-1');
    expect(result.reason).toBe('format-normalized');
    expect(result.changed).toBe(true);
  });

  it('prunes unsupported list items without inventing replacements', () => {
    const result = calibrateZeroMemAnswer(
      '{"answer":"Redis, Mem0"}',
      'Return JSON only as {"answer":"..."}. List the accepted dependencies.',
      [evidence('Redis is the only accepted dependency.')],
      { ...profile('list'), temporalCues: [] },
    );

    expect(result.answer).toBe('Redis');
    expect(result.reason).toBe('list-pruned');
  });

  it('retains an answer when no deterministic correction is available', () => {
    const result = calibrateZeroMemAnswer(
      '{"answer":"The adapter changes units for storage compatibility."}',
      'Return JSON only as {"answer":"..."}. Why is conversion required?',
      [evidence('The API uses milliseconds and the database uses seconds.')],
      { ...profile('explanation'), temporalCues: [] },
    );

    expect(result.answer).toContain('storage compatibility');
    expect(result.reason).toBe('unchanged');
  });

  it('preserves a supported boolean answer with an evidence-backed explanation', () => {
    const result = calibrateZeroMemAnswer(
      '{"answer":"No, the adapter patch is not active now. It was reverted Thursday."}',
      'Return JSON only as {"answer":"..."}. Is the adapter patch active now, and why?',
      [evidence('Thursday: the adapter patch was reverted and is not active now.')],
      profile('boolean'),
    );

    expect(result.answer).toContain('reverted Thursday');
    expect(result.reason).toBe('supported');
  });
});

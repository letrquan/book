import { describe, expect, it } from 'vitest';
import { projectAgentCompletion, projectAgentSummary } from './projections.js';
import type { AgentRecord } from './types.js';

const record = {
  id: 'agent-1',
  name: 'explorer',
  role: 'explorer',
  description: 'Explore',
  status: 'completed',
  applicationStatus: 'not_applied',
  prompt: 'Trace auth',
  result: 'Found it',
  referencedEvidenceIds: ['input-evidence'],
  producedEvidenceIds: ['published-evidence'],
  transcript: [
    { id: 'secret', role: 'assistant', content: 'raw', includeInContext: true, timestamp: 1 },
  ],
  pendingMessages: [],
  createdAt: 1,
  updatedAt: 2,
} as AgentRecord;

describe('managed-agent projections', () => {
  it('omits transcript and prompt from parent-facing output', () => {
    const summary = projectAgentSummary(record);
    const completion = projectAgentCompletion(record);
    expect(summary).not.toHaveProperty('transcript');
    expect(completion).not.toHaveProperty('prompt');
    expect(completion.evidenceIds).toEqual(['published-evidence']);
    expect(summary.finishedAt).toBe(record.updatedAt);
  });

  it('preserves normal-sized completion text for the parent', () => {
    const result = 'x'.repeat(20_522);
    const completion = projectAgentCompletion({ ...record, result });
    expect(completion.summary).toBe(result);
    expect(completion.summaryCharacters).toBe(20_522);
    expect(completion.summaryTruncated).toBe(false);
  });

  it('keeps list/status summaries compact while reporting the full size', () => {
    const result = 'x'.repeat(3000);
    const summary = projectAgentSummary({ ...record, result });
    expect(summary.summary?.length).toBe(2000);
    expect(summary.summaryCharacters).toBe(3000);
    expect(summary.summaryTruncated).toBe(true);
  });

  it('bounds unusually large completion text and reports truncation', () => {
    const result = 'x'.repeat(50 * 1024 + 1);
    const completion = projectAgentCompletion({ ...record, result });
    expect(completion.summary?.length).toBe(50 * 1024);
    expect(completion.summary?.endsWith('...')).toBe(true);
    expect(completion.summaryCharacters).toBe(result.length);
    expect(completion.summaryTruncated).toBe(true);
  });

  it('reports error length and truncation separately from the summary', () => {
    const error = 'failure '.repeat(7000);
    const completion = projectAgentCompletion({ ...record, result: undefined, error });
    expect(completion.summaryCharacters).toBe(0);
    expect(completion.summaryTruncated).toBe(false);
    expect(completion.error?.length).toBeLessThanOrEqual(50 * 1024);
    expect(completion.error?.endsWith('...')).toBe(true);
    expect(completion.errorCharacters).toBe(error.length);
    expect(completion.errorTruncated).toBe(true);
  });
});

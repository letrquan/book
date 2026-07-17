import { describe, expect, it } from 'vitest';
import { buildCompactRecord } from './compact-record.js';
import type { CompactResult, Message } from '../types.js';

function message(id: string): Message {
  return {
    id,
    role: 'user',
    content: id,
    includeInContext: true,
    timestamp: 1,
  };
}

describe('buildCompactRecord', () => {
  it('builds one record and matching durable boundary', () => {
    const checkpoint = {
      version: 2 as const,
      generation: 3,
      throughEventRef: 'session://current/event/old',
      stateAtCheckpoint: {
        taskSummary: 'summary',
        status: 'paused' as const,
        sourceRefs: ['session://current/event/old'],
      },
      constraints: [],
      files: [],
      episodes: [],
      openThreads: [],
      stats: {
        summarizedMessages: 7,
        retainedMessages: 1,
        estimatedPrefixTokens: 300,
        estimatedTailTokens: 80,
      },
    };
    const result: Extract<CompactResult, { status: 'compacted' }> = {
      status: 'compacted',
      trigger: 'manual',
      replacementHistory: [message('checkpoint'), message('recent')],
      summary: 'summary',
      checkpoint,
      preContextTokens: 400,
      preMessageCount: 9,
      retainedMessageCount: 1,
      estimatedPostTokens: 100,
      generation: 3,
    };

    const built = buildCompactRecord(result, {
      afterTranscriptOrdinal: 12,
      generation: 3,
      timestamp: 123,
      eventId: 'boundary-1',
      estimatedPostTokens: 100,
    });

    expect(built.record.type).toBe('compact');
    expect(built.record.eventId).toBe('boundary-1');
    expect(built.boundary).toMatchObject({
      id: 'boundary-1',
      timestamp: 123,
      afterTranscriptOrdinal: 12,
      preContextMessages: 9,
      retainedContextMessages: 1,
      preContextTokens: 400,
      estimatedPostTokens: 100,
      checkpointVersion: 2,
      generation: 3,
    });
    expect((built.record.data as { version: number }).version).toBe(2);
    expect((built.record.data as { boundary: unknown }).boundary).toEqual(built.boundary);
  });
});

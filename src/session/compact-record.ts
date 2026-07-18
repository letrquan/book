import type {
  CompactBoundary,
  CompactRecordData,
  CompactRecordDataV1,
  CompactRecordDataV2,
  CompactResult,
  ConversationCheckpointV2,
  SessionRecord,
} from '../types.js';

export interface BuildCompactRecordOptions {
  afterTranscriptOrdinal: number;
  generation: number;
  timestamp?: number;
  eventId?: string;
  estimatedPostTokens?: number;
  /** Override the compact result checkpoint. Omit only for legacy v1 callers. */
  checkpoint?: ConversationCheckpointV2;
}

export interface BuiltCompactRecord {
  boundary: CompactBoundary;
  data: CompactRecordData;
  record: SessionRecord;
}

/** Build the durable compact record shared by interactive and headless hosts. */
export function buildCompactRecord(
  result: Extract<CompactResult, { status: 'compacted' }>,
  options: BuildCompactRecordOptions,
): BuiltCompactRecord {
  const timestamp = options.timestamp ?? Date.now();
  const eventId = options.eventId ?? crypto.randomUUID();
  const checkpoint = options.checkpoint ?? result.checkpoint;
  const checkpointVersion = checkpoint?.version ?? 1;
  const boundary: CompactBoundary = {
    id: eventId,
    timestamp,
    trigger: result.trigger,
    afterTranscriptOrdinal: options.afterTranscriptOrdinal,
    preContextMessages: result.preMessageCount,
    retainedContextMessages: result.retainedMessageCount,
    preContextTokens: result.preContextTokens,
    estimatedPostTokens: options.estimatedPostTokens ?? result.estimatedPostTokens,
    checkpointVersion,
    generation: checkpoint?.generation ?? options.generation,
  };

  const legacyFields = {
    trigger: result.trigger,
    summary: result.summary,
    preContextTokens: result.preContextTokens,
    preMessageCount: result.preMessageCount,
    boundary,
    replacementHistory: result.replacementHistory,
  };
  const data: CompactRecordData = checkpoint
    ? ({ ...checkpoint, ...legacyFields } satisfies CompactRecordDataV2)
    : ({ version: 1, ...legacyFields } satisfies CompactRecordDataV1);

  return {
    boundary,
    data,
    record: {
      type: 'compact',
      eventId,
      timestamp,
      data,
    },
  };
}

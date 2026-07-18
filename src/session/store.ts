import {
  mkdirSync,
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from 'fs';
import { join, normalize, resolve } from 'path';
import type {
  CompactBoundary,
  CompactRecordData,
  LoadedSession,
  Message,
  SessionHistorySearchResult,
  SessionMeta,
  SessionRecord,
} from '../types.js';
import { createDebugLogger } from '../debug-log.js';

export type { SessionMeta } from '../types.js';

const log = createDebugLogger('session:store');
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 20;
const SEARCH_PREVIEW_CHARS = 400;
const READ_REF_LIMIT = 8;
const READ_TOTAL_CHARS = 16_000;
const TOOL_RESULT_PREVIEW_CHARS = 4_000;

function normalizeWorkspace(cwd: string): string {
  const normalized = normalize(resolve(cwd));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function eventIdFor(record: SessionRecord, ordinal: number): string {
  return record.eventId ?? `legacy-line-${ordinal}`;
}

function eventRef(eventId: string): string {
  return `session://current/event/${eventId}`;
}

function isEventRecord(record: SessionRecord): boolean {
  return record.type !== 'session_meta';
}

function hasDurableEventIdentity(record: SessionRecord): boolean {
  return (
    record.type === 'user' ||
    record.type === 'assistant' ||
    record.type === 'local' ||
    record.type === 'compact'
  );
}

function recordToolNames(record: SessionRecord): string[] | undefined {
  const data = record.data as {
    name?: unknown;
    toolCalls?: Array<{ name?: unknown }>;
  };
  const names = new Set<string>();
  if (typeof data?.name === 'string') names.add(data.name);
  if (Array.isArray(data?.toolCalls)) {
    for (const call of data.toolCalls) {
      if (typeof call?.name === 'string') names.add(call.name);
    }
  }
  return names.size > 0 ? [...names] : undefined;
}

function recordText(record: SessionRecord): string {
  const data = record.data as {
    content?: unknown;
    contextContent?: unknown;
    summary?: unknown;
    error?: unknown;
    output?: unknown;
    toolCalls?: unknown;
    toolResults?: unknown;
  };
  const parts: string[] = [];
  if (typeof data?.content === 'string') parts.push(data.content);
  if (typeof data?.contextContent === 'string' && data.contextContent !== data.content) {
    parts.push(data.contextContent);
  }
  if (typeof data?.summary === 'string') parts.push(data.summary);
  if (data?.toolCalls !== undefined) parts.push(JSON.stringify(data.toolCalls));
  if (data?.toolResults !== undefined) parts.push(JSON.stringify(data.toolResults));
  if (typeof data?.output === 'string') parts.push(data.output);
  if (typeof data?.error === 'string') parts.push(data.error);
  if (parts.length > 0) return parts.join('\n');
  try {
    return JSON.stringify(record.data) ?? '';
  } catch {
    return String(record.data ?? '');
  }
}

function isMessageLike(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Message>;
  return (
    (candidate.role === 'user' || candidate.role === 'assistant') &&
    typeof candidate.content === 'string'
  );
}

function validCompactData(data: unknown): CompactRecordData | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const compact = data as Partial<CompactRecordData> & Record<string, unknown>;
  if (compact.version !== 1 && compact.version !== 2) return undefined;
  if (compact.trigger !== 'manual' && compact.trigger !== 'auto') return undefined;
  if (typeof compact.summary !== 'string') return undefined;
  if (!Array.isArray(compact.replacementHistory) || compact.replacementHistory.length === 0) {
    return undefined;
  }
  if (!compact.replacementHistory.every(isMessageLike)) return undefined;
  if (
    compact.version === 2 &&
    (!Number.isInteger(compact.generation) ||
      typeof compact.throughEventRef !== 'string' ||
      !compact.stateAtCheckpoint ||
      typeof compact.stateAtCheckpoint !== 'object' ||
      !Array.isArray(compact.constraints) ||
      !Array.isArray(compact.files) ||
      !Array.isArray(compact.episodes) ||
      !Array.isArray(compact.openThreads) ||
      !compact.stats ||
      typeof compact.stats !== 'object')
  ) {
    return undefined;
  }
  return compact as CompactRecordData;
}

function replayMessage(
  message: Message,
  fallbackId: string,
  fallbackTimestamp: number,
  checkpoint?: ConversationCheckpointV2,
  checkpointMessage = false,
): Message {
  return {
    id: typeof message.id === 'string' && message.id ? message.id : fallbackId,
    role: message.role,
    content: message.content,
    contextContent: message.contextContent,
    includeInContext: message.includeInContext ?? true,
    kind: checkpointMessage ? 'checkpoint' : (message.kind ?? 'conversation'),
    checkpoint: message.checkpoint ?? (checkpointMessage ? checkpoint : undefined),
    toolCalls: message.toolCalls,
    toolResults: message.toolResults,
    nestedToolInvocations: message.nestedToolInvocations,
    fileObservations: message.fileObservations,
    timestamp: message.timestamp ?? fallbackTimestamp,
  };
}

function compactCheckpoint(data: CompactRecordData): ConversationCheckpointV2 | undefined {
  return data.version === 2 ? data : undefined;
}

function compactBoundary(
  record: SessionRecord,
  eventId: string,
  data: CompactRecordData,
  transcriptLength: number,
  activeContextLength: number,
  retainedContextLength: number,
  priorBoundaryCount: number,
): CompactBoundary {
  const stored = data.boundary;
  return {
    id: stored?.id ?? eventId,
    timestamp: stored?.timestamp ?? record.timestamp,
    trigger: stored?.trigger ?? data.trigger,
    afterTranscriptOrdinal: stored?.afterTranscriptOrdinal ?? transcriptLength,
    preContextMessages: stored?.preContextMessages ?? data.preMessageCount ?? activeContextLength,
    retainedContextMessages: stored?.retainedContextMessages ?? retainedContextLength,
    preContextTokens: stored?.preContextTokens ?? data.preContextTokens,
    estimatedPostTokens: stored?.estimatedPostTokens,
    checkpointVersion: data.version,
    generation:
      stored?.generation ?? (data.version === 2 ? data.generation : priorBoundaryCount + 1),
  };
}

function boundedEvents(
  events: SessionHistoryEvent[],
  maxEvents: number,
  maxChars: number,
): SessionHistoryEvent[] {
  const bounded: SessionHistoryEvent[] = [];
  let remaining = maxChars;
  for (const event of events) {
    if (bounded.length >= maxEvents || remaining <= 0) break;
    const text = event.text.slice(0, remaining);
    bounded.push({ ...event, text });
    remaining -= text.length;
  }
  return bounded;
}

function parseSingleRef(ref: string): { eventId: string; toolCallId?: string } | undefined {
  const prefix = 'session://current/event/';
  if (!ref.startsWith(prefix)) return undefined;
  const rest = ref.slice(prefix.length);
  const marker = '/tool-result/';
  const markerIndex = rest.indexOf(marker);
  if (markerIndex < 0) return rest ? { eventId: rest } : undefined;
  const eventId = rest.slice(0, markerIndex);
  const toolCallId = rest.slice(markerIndex + marker.length);
  return eventId && toolCallId ? { eventId, toolCallId } : undefined;
}

function parseRangeRef(ref: string): { first: string; last: string } | undefined {
  const prefix = 'session://current/events/';
  if (!ref.startsWith(prefix)) return undefined;
  const separator = ref.slice(prefix.length).indexOf('..');
  if (separator < 0) return undefined;
  const rest = ref.slice(prefix.length);
  const first = rest.slice(0, separator);
  const last = rest.slice(separator + 2);
  return first && last ? { first, last } : undefined;
}

function toolResultText(record: SessionRecord, toolCallId: string): string | undefined {
  const data = record.data as {
    toolResults?: Array<{ toolCallId?: unknown; output?: unknown; error?: unknown }>;
  };
  const result = data?.toolResults?.find((candidate) => candidate.toolCallId === toolCallId);
  if (!result) return undefined;
  const output = typeof result.output === 'string' ? result.output : '';
  const error = typeof result.error === 'string' ? result.error : '';
  return [output, error].filter(Boolean).join('\n');
}

/**
 * JSONL session persistence. Each session is one file under <root>/<id>.jsonl.
 * The append-only event stream is replayed into an immutable visible transcript
 * and a replaceable provider-facing context projection.
 */
export class SessionStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  private path(id: string): string {
    return join(this.root, `${id}.jsonl`);
  }

  private records(id: string): SessionRecord[] {
    const p = this.path(id);
    if (!existsSync(p)) throw new Error(`Session not found: ${id}`);
    return readFileSync(p, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionRecord);
  }

  create(meta: { cwd: string; name?: string; id?: string }): string {
    const id = meta.id ?? crypto.randomUUID();
    const now = Date.now();
    const header: SessionRecord = {
      type: 'session_meta',
      timestamp: now,
      data: {
        kind: 'session_meta',
        id,
        cwd: normalizeWorkspace(meta.cwd),
        name: meta.name,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      },
    };
    appendFileSync(this.path(id), JSON.stringify(header) + '\n', 'utf-8');
    return id;
  }

  append(id: string, record: SessionRecord): void {
    const persisted =
      record.eventId === undefined && hasDurableEventIdentity(record)
        ? { ...record, eventId: crypto.randomUUID() }
        : record;
    appendFileSync(this.path(id), JSON.stringify(persisted) + '\n', 'utf-8');
  }

  /** Copy the ordered event stream without flattening compact or local records. */
  copyEvents(sourceId: string, targetId: string): void {
    const records = this.records(sourceId);
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!isEventRecord(record)) continue;
      this.append(targetId, {
        ...record,
        eventId: record.eventId ?? `legacy-line-${index + 1}`,
      });
    }
  }

  fork(sourceId: string, meta: { cwd: string; name?: string; id?: string }): string {
    const targetId = this.create(meta);
    this.copyEvents(sourceId, targetId);
    return targetId;
  }

  readRecords(id: string): SessionRecord[] {
    const p = this.path(id);
    if (!existsSync(p)) throw new Error(`Session not found: ${id}`);
    return readFileSync(p, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionRecord);
  }

  patchMeta(id: string, patch: { name?: string }): void {
    this.append(id, {
      type: 'session_meta',
      timestamp: Date.now(),
      data: { kind: 'session_meta_patch', ...patch },
    });
  }

  touch(id: string): void {
    this.append(id, {
      type: 'session_meta',
      timestamp: Date.now(),
      data: { kind: 'session_touch' },
    });
  }

  load(id: string): LoadedSession {
    const records = this.readRecords(id);

    const metaRec = records.find(
      (record) => (record.data as { kind?: string })?.kind === 'session_meta',
    );
    const storedMeta = metaRec?.data as Partial<SessionMeta> | undefined;
    const meta: SessionMeta = {
      id,
      cwd: normalizeWorkspace(storedMeta?.cwd ?? ''),
      createdAt: storedMeta?.createdAt ?? 0,
      updatedAt: storedMeta?.updatedAt ?? 0,
      messageCount: 0,
      ...(storedMeta?.name === undefined ? {} : { name: storedMeta.name }),
    };

    const transcript: Message[] = [];
    const contextHistory: Message[] = [];
    const compactBoundaries: CompactBoundary[] = [];
    let count = 0;
    for (let lineIndex = 0; lineIndex < records.length; lineIndex++) {
      const record = records[lineIndex];
      const eventId = record.eventId ?? `legacy-line-${lineIndex + 1}`;
      const data = record.data as {
        kind?: string;
        name?: string;
        role?: Message['role'];
        content?: string;
        contextContent?: string;
        includeInContext?: boolean;
        complete?: boolean;
        toolCalls?: Message['toolCalls'];
        toolResults?: Message['toolResults'];
        version?: number;
        replacementHistory?: Message[];
        summary?: string;
        trigger?: string;
        preContextTokens?: number;
        id?: string;
        includeInContext?: boolean;
        fileObservations?: Message['fileObservations'];
      };

      if (data.kind === 'session_meta_patch') {
        if (Object.prototype.hasOwnProperty.call(data, 'name')) meta.name = data.name;
        continue;
      }
      if (data.kind === 'session_meta' || data.kind === 'session_touch') continue;

      // Atomic compact boundary: replace only provider context after validation.
      if (record.type === 'compact') {
        const compactData = data as unknown as CompactRecordData;
        if (!isValidCompactRecord(compactData)) {
          log.warn('ignoring malformed compact record', { id, eventId });
          continue;
        }
        const replacement = compactData.replacementHistory.map((msg, index) =>
          restoreMessage(msg, `${eventId}-replacement-${index + 1}`, record.timestamp),
        );
        const boundary =
          compactData.version === 2
            ? { ...compactData.boundary, transcriptOrdinal: transcript.length }
            : synthesizeV1Boundary(
                eventId,
                record.timestamp,
                transcript.length,
                contextHistory.length,
                replacement.length,
                compactData.preContextTokens,
                compactBoundaries.length + 1,
                compactData.trigger,
              );
        contextHistory.length = 0;
        contextHistory.push(...replacement);
        compactBoundaries.push(boundary);
        continue;
      }

      if (record.type === 'user') {
        count++;
        const message: Message = {
          id: data.id ?? eventId,
          role: 'user',
          content: data.content ?? '',
          contextContent: data.contextContent,
          includeInContext: data.includeInContext ?? true,
          kind: (data.kind as Message['kind']) ?? 'conversation',
          fileObservations: data.fileObservations,
          timestamp: record.timestamp,
        };
        transcript.push(message);
        if (message.includeInContext) contextHistory.push(message);
      } else if (record.type === 'local') {
        count++;
        transcript.push({
          id: data.id ?? eventId,
          role: 'assistant',
          content: data.content ?? '',
          includeInContext: false,
          kind: 'local',
          timestamp: record.timestamp,
        });
      } else if (record.type === 'assistant') {
        if (data.complete) {
          count++;
          const message: Message = {
            id: data.id ?? eventId,
            role: 'assistant',
            content: data.content ?? '',
            contextContent: data.contextContent,
            includeInContext: data.includeInContext ?? true,
            kind: (data.kind as Message['kind']) ?? 'conversation',
            toolCalls: data.toolCalls,
            toolResults: data.toolResults,
            fileObservations: data.fileObservations,
            timestamp: record.timestamp,
          };
          transcript.push(message);
          if (message.includeInContext) contextHistory.push(message);
        } else {
          const last = transcript[transcript.length - 1];
          if (last?.role === 'assistant') {
            last.content += data.content ?? '';
            const contextLast = contextHistory[contextHistory.length - 1];
            if (contextLast?.id === last.id && contextLast !== last) {
              contextLast.content = last.content;
            }
          } else {
            count++;
            const message: Message = {
              id: data.id ?? eventId,
              role: 'assistant',
              content: data.content ?? '',
              includeInContext: true,
              kind: 'conversation',
              timestamp: record.timestamp,
            };
            transcript.push(message);
            contextHistory.push(message);
          }
        }
      }
    }

    if (records.length) meta.updatedAt = records[records.length - 1].timestamp;
    meta.messageCount = count;
    return { transcript, contextHistory, compactBoundaries, meta, history: contextHistory };
  }

  fork(sourceId: string, meta: { cwd: string; name?: string; id?: string }): string {
    const targetId = this.create(meta);
    for (const record of this.readRecords(sourceId)) {
      const kind = (record.data as { kind?: string })?.kind;
      if (kind === 'session_meta' || kind === 'session_meta_patch' || kind === 'session_touch') {
        continue;
      }
      this.append(targetId, record);
    }
    this.touch(targetId);
    return targetId;
  }

  searchCurrent(
    id: string,
    query: string,
    limit = SEARCH_LIMIT_DEFAULT,
  ): SessionHistorySearchResult[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const capped = Math.max(1, Math.min(SEARCH_LIMIT_MAX, limit));
    const results: SessionHistorySearchResult[] = [];
    for (const [index, record] of this.readRecords(id).entries()) {
      if (!['user', 'assistant', 'local'].includes(record.type)) continue;
      const eventId = record.eventId ?? `legacy-line-${index + 1}`;
      const data = record.data as {
        content?: string;
        contextContent?: string;
        toolCalls?: Message['toolCalls'];
        toolResults?: Message['toolResults'];
      };
      const haystack = [
        data.content ?? '',
        data.contextContent ?? '',
        ...(data.toolCalls ?? []).flatMap((call) => [call.name, JSON.stringify(call.arguments)]),
        ...(data.toolResults ?? []).map((result) => result.output),
      ].join('\n');
      if (!haystack.toLowerCase().includes(needle)) continue;
      results.push({
        ref: `session://current/event/${eventId}`,
        role: record.type === 'user' ? 'user' : 'assistant',
        preview: clipPreview(haystack, SEARCH_PREVIEW_CHARS),
        timestamp: record.timestamp,
      });
      if (results.length >= capped) break;
    }
    return results;
  }

  readCurrent(id: string, refs: string[]): Array<{ ref: string; content: string }> {
    if (refs.length > READ_REF_LIMIT)
      throw new Error(`At most ${READ_REF_LIMIT} references per call.`);
    const records = this.readRecords(id);
    const byId = new Map(
      records.map((record, index) => [record.eventId ?? `legacy-line-${index + 1}`, record]),
    );
    const output: Array<{ ref: string; content: string }> = [];
    let remaining = READ_TOTAL_CHARS;
    for (const ref of refs) {
      const parsed = parseCurrentSessionRef(ref);
      const record = byId.get(parsed.eventId);
      if (!record) throw new Error(`Unknown session history reference: ${ref}`);
      const data = record.data as {
        content?: string;
        contextContent?: string;
        toolCalls?: Message['toolCalls'];
        toolResults?: Message['toolResults'];
      };
      let content: string;
      if (parsed.toolCallId) {
        const result = data.toolResults?.find((item) => item.toolCallId === parsed.toolCallId);
        if (!result) throw new Error(`Unknown tool-result reference: ${ref}`);
        content = clipHeadTail(result.output ?? result.error ?? '', TOOL_RESULT_PREVIEW_CHARS);
      } else {
        content = JSON.stringify(
          {
            role: record.type,
            content: data.contextContent ?? data.content ?? '',
            toolCalls: data.toolCalls,
            toolResults: data.toolResults?.map((result) => ({
              ...result,
              output: clipHeadTail(result.output ?? '', TOOL_RESULT_PREVIEW_CHARS),
            })),
          },
          null,
          2,
        );
      }
      content = content.slice(0, remaining);
      output.push({ ref, content });
      remaining -= content.length;
      if (remaining <= 0) break;
    }
    return output;
  }

  list(): SessionMeta[] {
    const metas: SessionMeta[] = [];
    for (const file of readdirSync(this.root)) {
      if (!file.endsWith('.jsonl')) continue;
      const id = file.replace(/\.jsonl$/, '');
      try {
        metas.push(this.load(id).meta);
      } catch {
        // Skip corrupt files.
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  mostRecentInCwd(cwd: string): SessionMeta | undefined {
    const normalized = normalizeWorkspace(cwd);
    return this.list().find((meta) => meta.cwd === normalized);
  }

  findByName(name: string): SessionMeta | undefined {
    return this.list().find((meta) => meta.name === name);
  }

  findById(id: string): SessionMeta | undefined {
    return this.list().find((meta) => meta.id === id);
  }

  cleanup(days: number): number {
    const cutoff = Date.now() - days * 86400_000;
    let removed = 0;
    for (const file of readdirSync(this.root)) {
      if (!file.endsWith('.jsonl')) continue;
      const id = file.replace(/\.jsonl$/, '');
      try {
        const { meta } = this.load(id);
        if (meta.updatedAt < cutoff) {
          unlinkSync(this.path(id));
          removed++;
        }
      } catch {
        if (statSync(this.path(id)).mtimeMs < cutoff) {
          unlinkSync(this.path(id));
          removed++;
        }
      }
    }
    return removed;
  }
}

function restoreMessage(message: Message, fallbackId: string, timestamp: number): Message {
  return {
    ...message,
    id: message.id || fallbackId,
    content: message.content ?? '',
    includeInContext: message.includeInContext ?? true,
    kind: message.kind ?? (message.includeInContext === false ? 'local' : 'conversation'),
    timestamp: message.timestamp ?? timestamp,
  };
}

function isValidCompactRecord(data: CompactRecordData): boolean {
  if (data?.version !== 1 && data?.version !== 2) return false;
  if (!Array.isArray(data.replacementHistory) || data.replacementHistory.length === 0) return false;
  if (data.version === 2) {
    return (
      !!data.compactId && !!data.checkpoint && data.checkpoint.version === 2 && !!data.boundary
    );
  }
  return typeof data.summary === 'string';
}

function synthesizeV1Boundary(
  id: string,
  timestamp: number,
  transcriptOrdinal: number,
  preContextCount: number,
  postContextCount: number,
  preContextTokens: number | undefined,
  generation: number,
  trigger: CompactBoundary['trigger'],
): CompactBoundary {
  return {
    id,
    trigger,
    transcriptOrdinal,
    preContextCount,
    postContextCount,
    preContextTokens,
    generation,
    checkpointVersion: 1,
    timestamp,
  };
}

function clipPreview(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

function clipHeadTail(value: string, max: number): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 40) / 2);
  return `${value.slice(0, half)}\n[... output clipped ...]\n${value.slice(-half)}`;
}

function parseCurrentSessionRef(ref: string): { eventId: string; toolCallId?: string } {
  const eventMatch = /^session:\/\/current\/event\/([^/]+)$/.exec(ref);
  if (eventMatch) return { eventId: eventMatch[1] };
  const toolMatch = /^session:\/\/current\/tool-result\/([^/]+)\/([^/]+)$/.exec(ref);
  if (toolMatch) return { eventId: toolMatch[1], toolCallId: toolMatch[2] };
  throw new Error(
    'References must use session://current/event/... or session://current/tool-result/...',
  );
}

export { normalizeWorkspace };

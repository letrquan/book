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
  ConversationCheckpointV2,
  LoadedSession,
  Message,
  SessionEventReadOptions,
  SessionEventSearchOptions,
  SessionHistoryEvent,
  SessionMeta,
  SessionRecord,
} from '../types.js';

export type { SessionMeta } from '../types.js';

const READ_EVENTS_DEFAULT_LIMIT = 20;
const READ_EVENTS_MAX_LIMIT = 100;
const READ_EVENTS_DEFAULT_CHARS = 20_000;
const READ_EVENTS_MAX_CHARS = 100_000;
const SEARCH_EVENTS_DEFAULT_LIMIT = 10;
const SEARCH_EVENTS_MAX_LIMIT = 50;
const SEARCH_PREVIEW_DEFAULT_CHARS = 500;
const SEARCH_PREVIEW_MAX_CHARS = 2_000;

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
    const records = this.records(id);
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
    let conversationCount = 0;

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const eventId = eventIdFor(record, index + 1);
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
        fileObservations?: Message['fileObservations'];
      };

      if (data.kind === 'session_meta_patch') {
        if (Object.prototype.hasOwnProperty.call(data, 'name')) meta.name = data.name;
        continue;
      }
      if (data.kind === 'session_meta' || data.kind === 'session_touch') continue;

      if (record.type === 'compact') {
        const compactData = validCompactData(record.data);
        if (!compactData) continue;
        const replacement = compactData.replacementHistory;
        const checkpoint = compactCheckpoint(compactData);
        const replayed = replacement.map((message, replacementIndex) =>
          replayMessage(
            message,
            `${eventId}-replacement-${replacementIndex + 1}`,
            record.timestamp,
            checkpoint,
            compactData.version === 2 && replacementIndex === 0,
          ),
        );
        compactBoundaries.push(
          compactBoundary(
            record,
            eventId,
            compactData,
            transcript.length,
            contextHistory.length,
            replayed.length,
            compactBoundaries.length,
          ),
        );
        contextHistory.length = 0;
        contextHistory.push(...replayed);
        continue;
      }

      const local =
        record.type === 'local' || data.kind === 'local' || data.includeInContext === false;
      if (record.type === 'local' || record.type === 'user' || record.type === 'assistant') {
        const role = record.type === 'user' ? 'user' : (data.role ?? 'assistant');
        if (record.type === 'assistant' && !local && !data.complete) {
          const lastTranscript = transcript[transcript.length - 1];
          const lastContext = contextHistory[contextHistory.length - 1];
          if (lastTranscript?.role === 'assistant' && lastTranscript === lastContext) {
            lastTranscript.content += data.content ?? '';
            continue;
          }
        }

        const message: Message = {
          id: eventId,
          role,
          content: data.content ?? '',
          contextContent: data.contextContent,
          includeInContext: !local,
          kind: local ? 'local' : 'conversation',
          toolCalls: data.toolCalls,
          toolResults: data.toolResults,
          fileObservations: data.fileObservations,
          timestamp: record.timestamp,
        };
        transcript.push(message);
        if (!local) {
          conversationCount++;
          contextHistory.push(message);
        }
      }
    }

    if (records.length) meta.updatedAt = records[records.length - 1].timestamp;
    meta.messageCount = conversationCount;
    return {
      transcript,
      contextHistory,
      history: contextHistory,
      compactBoundaries,
      meta,
    };
  }

  readEvents(id: string, options: SessionEventReadOptions = {}): SessionHistoryEvent[] {
    const records = this.records(id);
    const events: SessionHistoryEvent[] = [];
    const recordsByEventId = new Map<string, SessionRecord>();

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!isEventRecord(record)) continue;
      const ordinal = index + 1;
      const eventId = eventIdFor(record, ordinal);
      recordsByEventId.set(eventId, record);
      events.push({
        eventId,
        ref: eventRef(eventId),
        ordinal,
        type: record.type,
        timestamp: record.timestamp,
        data: record.data,
        text: recordText(record),
        toolNames: recordToolNames(record),
      });
    }

    let selected: SessionHistoryEvent[];
    if (options.refs && options.refs.length > 0) {
      const byId = new Map(events.map((event) => [event.eventId, event]));
      selected = [];
      const seen = new Set<string>();
      for (const ref of options.refs) {
        const range = parseRangeRef(ref);
        if (range) {
          const firstIndex = events.findIndex((event) => event.eventId === range.first);
          const lastIndex = events.findIndex((event) => event.eventId === range.last);
          if (firstIndex < 0 || lastIndex < firstIndex) continue;
          for (const event of events.slice(firstIndex, lastIndex + 1)) {
            if (!seen.has(event.ref)) {
              selected.push(event);
              seen.add(event.ref);
            }
          }
          continue;
        }

        const parsed = parseSingleRef(ref);
        if (!parsed) continue;
        const event = byId.get(parsed.eventId);
        if (!event) continue;
        if (parsed.toolCallId) {
          const record = recordsByEventId.get(parsed.eventId);
          const text = record && toolResultText(record, parsed.toolCallId);
          if (text === undefined || seen.has(ref)) continue;
          selected.push({ ...event, ref, text });
          seen.add(ref);
        } else if (!seen.has(event.ref)) {
          selected.push(event);
          seen.add(event.ref);
        }
      }
    } else {
      const startOrdinal = Math.max(1, Math.floor(options.startOrdinal ?? 1));
      selected = events.filter((event) => event.ordinal >= startOrdinal);
    }

    return boundedEvents(
      selected,
      clamp(options.limit, READ_EVENTS_DEFAULT_LIMIT, READ_EVENTS_MAX_LIMIT),
      clamp(options.maxChars, READ_EVENTS_DEFAULT_CHARS, READ_EVENTS_MAX_CHARS),
    );
  }

  searchEvents(id: string, options: SessionEventSearchOptions): SessionHistoryEvent[] {
    const query = options.query.trim().toLocaleLowerCase();
    if (!query) return [];
    const limit = clamp(options.limit, SEARCH_EVENTS_DEFAULT_LIMIT, SEARCH_EVENTS_MAX_LIMIT);
    const previewChars = clamp(
      options.previewChars,
      SEARCH_PREVIEW_DEFAULT_CHARS,
      SEARCH_PREVIEW_MAX_CHARS,
    );
    const maxChars = clamp(
      options.maxChars,
      Math.min(READ_EVENTS_DEFAULT_CHARS, limit * previewChars),
      READ_EVENTS_MAX_CHARS,
    );
    const matches: SessionHistoryEvent[] = [];
    const records = this.records(id);
    for (let index = 0; index < records.length && matches.length < limit; index++) {
      const record = records[index];
      if (!isEventRecord(record)) continue;
      const ordinal = index + 1;
      const eventId = eventIdFor(record, ordinal);
      const ref = eventRef(eventId);
      const text = recordText(record);
      const toolNames = recordToolNames(record);
      const haystack = [record.type, ref, text, ...(toolNames ?? [])]
        .join('\n')
        .toLocaleLowerCase();
      if (!haystack.includes(query)) continue;
      matches.push({
        eventId,
        ref,
        ordinal,
        type: record.type,
        timestamp: record.timestamp,
        data: record.data,
        text:
          text.length > previewChars ? `${text.slice(0, Math.max(0, previewChars - 1))}…` : text,
        toolNames,
      });
    }
    return boundedEvents(matches, limit, maxChars);
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

export { normalizeWorkspace };

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

/**
 * JSONL session persistence. Each session is one file under <root>/<id>.jsonl.
 * The first line is a session_meta record; subsequent lines are event records
 * (user / assistant / tool_call / tool_result / usage). load() replays the
 * records into a Message[] history the agent loop can resume from.
 */
export class SessionStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  private path(id: string): string {
    return join(this.root, `${id}.jsonl`);
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
    appendFileSync(this.path(id), JSON.stringify(record) + '\n', 'utf-8');
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
        content?: string;
        contextContent?: string;
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

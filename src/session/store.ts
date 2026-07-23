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
  RewindRecordData,
  RewindTarget,
  SessionHistorySearchResult,
  SessionMeta,
  SessionRecord,
  TurnCheckpointRecordData,
} from '../types/sessions.js';
import type { Message } from '../types/messages.js';
import { createDebugLogger } from '../debug-log.js';
import { normalizeToolResult } from '../tools/result.js';
import { deriveSessionName } from './name.js';

export type { SessionMeta } from '../types/sessions.js';

const log = createDebugLogger('session:store');
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 20;
const SEARCH_PREVIEW_CHARS = 400;
const READ_REF_LIMIT = 8;
const READ_TOTAL_CHARS = 16_000;
const TOOL_RESULT_PREVIEW_CHARS = 4_000;

interface ReplayLink<T> {
  value: T;
  previous?: ReplayLink<T>;
}

type PersistedToolResult = Parameters<typeof normalizeToolResult>[0];

function appendReplayLink<T>(previous: ReplayLink<T> | undefined, value: T): ReplayLink<T> {
  return { value, previous };
}

function replayLinkValues<T>(tail: ReplayLink<T> | undefined): T[] {
  const values: T[] = [];
  for (let current = tail; current; current = current.previous) values.push(current.value);
  return values.reverse();
}

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
    const records: SessionRecord[] = [];
    for (const [index, line] of readFileSync(p, 'utf-8').split('\n').entries()) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as SessionRecord);
      } catch {
        log.warn('ignoring corrupt session record', { id, line: index + 1 });
      }
    }
    return records;
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

    let transcript: Message[] = [];
    let contextHistory: Message[] = [];
    let compactBoundaries: CompactBoundary[] = [];
    let activeEventTail: ReplayLink<string> | undefined;
    let activeTargetTail: ReplayLink<string> | undefined;
    const targets = new Map<string, RewindTarget>();
    const targetStates = new Map<
      string,
      {
        transcript: Message[];
        contextHistory: Message[];
        compactBoundaries: CompactBoundary[];
        activeEventTail?: ReplayLink<string>;
        activeTargetTail?: ReplayLink<string>;
        count: number;
      }
    >();
    const checkpointByUserEventId = new Map<string, string>();
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
        toolResults?: PersistedToolResult[];
        version?: number;
        replacementHistory?: Message[];
        summary?: string;
        trigger?: string;
        preContextTokens?: number;
        id?: string;
        includeInContext?: boolean;
        fileObservations?: Message['fileObservations'];
        agentNotifications?: Message['agentNotifications'];
      };

      if (data.kind === 'session_meta_patch') {
        if (Object.prototype.hasOwnProperty.call(data, 'name')) meta.name = data.name;
        continue;
      }
      if (data.kind === 'session_meta' || data.kind === 'session_touch') continue;

      if (record.type === 'turn_checkpoint') {
        const checkpoint = record.data as TurnCheckpointRecordData;
        if (
          checkpoint?.version !== 1 ||
          !checkpoint.checkpointId ||
          !checkpoint.userEventId ||
          typeof checkpoint.prompt !== 'string'
        ) {
          log.warn('ignoring malformed turn checkpoint', { id, eventId });
          continue;
        }
        const target: RewindTarget = {
          id: checkpoint.checkpointId,
          userEventId: checkpoint.userEventId,
          prompt: checkpoint.prompt,
          timestamp: record.timestamp,
          ...checkpoint.checkpoint,
          codeAvailable: Boolean(
            checkpoint.checkpoint.snapshotId && !checkpoint.checkpoint.codeUnavailableReason,
          ),
        };
        targets.set(target.id, target);
        targetStates.set(target.id, {
          transcript,
          contextHistory,
          compactBoundaries,
          activeEventTail,
          activeTargetTail,
          count,
        });
        checkpointByUserEventId.set(checkpoint.userEventId, target.id);
        continue;
      }

      if (record.type === 'rewind') {
        const rewind = record.data as RewindRecordData;
        const rewindTarget = targets.get(rewind?.targetId);
        if (
          rewind?.version !== 1 ||
          !['conversation', 'code', 'both'].includes(rewind.action) ||
          rewindTarget?.userEventId !== rewind.targetUserEventId ||
          !replayLinkValues(activeTargetTail).includes(rewind.targetId)
        ) {
          log.warn('ignoring malformed or inactive rewind record', { id, eventId });
          continue;
        }
        if (rewind.action === 'conversation' || rewind.action === 'both') {
          const state = targetStates.get(rewind.targetId);
          if (!state) {
            log.warn('ignoring rewind with unknown target', { id, eventId });
            continue;
          }
          transcript = state.transcript;
          contextHistory = state.contextHistory;
          compactBoundaries = state.compactBoundaries;
          activeEventTail = state.activeEventTail;
          activeTargetTail = state.activeTargetTail;
          count = state.count;
        }
        continue;
      }

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
        contextHistory = replacement;
        compactBoundaries = [...compactBoundaries, boundary];
        activeEventTail = appendReplayLink(activeEventTail, eventId);
        continue;
      }

      if (record.type === 'user') {
        let targetId = checkpointByUserEventId.get(eventId);
        if (!targetId) {
          targetId = `user:${eventId}`;
          const legacyTarget: RewindTarget = {
            id: targetId,
            userEventId: eventId,
            prompt: data.content ?? '',
            timestamp: record.timestamp,
            codeAvailable: false,
            codeUnavailableReason: 'No filesystem checkpoint was captured for this turn.',
          };
          targets.set(targetId, legacyTarget);
          targetStates.set(targetId, {
            transcript,
            contextHistory,
            compactBoundaries,
            activeEventTail,
            activeTargetTail,
            count,
          });
        }
        count++;
        const message: Message = {
          id: data.id ?? eventId,
          role: 'user',
          content: data.content ?? '',
          contextContent: data.contextContent,
          includeInContext: data.includeInContext ?? true,
          kind: (data.kind as Message['kind']) ?? 'conversation',
          agentNotifications: data.agentNotifications,
          fileObservations: data.fileObservations,
          timestamp: record.timestamp,
        };
        transcript = [...transcript, message];
        if (message.includeInContext) contextHistory = [...contextHistory, message];
        activeEventTail = appendReplayLink(activeEventTail, eventId);
        activeTargetTail = appendReplayLink(activeTargetTail, targetId);
      } else if (record.type === 'local') {
        count++;
        transcript = [
          ...transcript,
          {
            id: data.id ?? eventId,
            role: 'assistant',
            content: data.content ?? '',
            includeInContext: false,
            kind: 'local',
            timestamp: record.timestamp,
          },
        ];
        activeEventTail = appendReplayLink(activeEventTail, eventId);
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
            agentNotifications: data.agentNotifications,
            toolCalls: data.toolCalls,
            toolResults: normalizePersistedToolResults(data.toolResults),
            fileObservations: data.fileObservations,
            timestamp: record.timestamp,
          };
          transcript = [...transcript, message];
          if (message.includeInContext) contextHistory = [...contextHistory, message];
          activeEventTail = appendReplayLink(activeEventTail, eventId);
        } else {
          const last = transcript[transcript.length - 1];
          if (last?.role === 'assistant') {
            const updated = { ...last, content: last.content + (data.content ?? '') };
            transcript = [...transcript.slice(0, -1), updated];
            const contextLast = contextHistory[contextHistory.length - 1];
            if (contextLast?.id === last.id) {
              contextHistory = [...contextHistory.slice(0, -1), updated];
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
            transcript = [...transcript, message];
            contextHistory = [...contextHistory, message];
          }
          activeEventTail = appendReplayLink(activeEventTail, eventId);
        }
      }
    }

    if (records.length) meta.updatedAt = records[records.length - 1].timestamp;
    meta.messageCount = count;
    if (!meta.name) {
      const firstUserPrompt = transcript.find(
        (message) => message.role === 'user' && message.kind !== 'local',
      )?.content;
      if (firstUserPrompt) meta.name = deriveSessionName(firstUserPrompt);
    }
    const activeTargetIds = replayLinkValues(activeTargetTail);
    const activeEventIds = replayLinkValues(activeEventTail);
    const rewindTargets = activeTargetIds
      .map((targetId) => targets.get(targetId))
      .filter((target): target is RewindTarget => Boolean(target))
      .reverse();
    return {
      transcript,
      contextHistory,
      compactBoundaries,
      rewindTargets,
      activeEventIds,
      meta,
      history: contextHistory,
    };
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
    const activeEventIds = new Set(this.load(id).activeEventIds);
    for (const [index, record] of this.readRecords(id).entries()) {
      if (!['user', 'assistant', 'local'].includes(record.type)) continue;
      const eventId = record.eventId ?? `legacy-line-${index + 1}`;
      if (!activeEventIds.has(eventId)) continue;
      const data = record.data as {
        content?: string;
        contextContent?: string;
        toolCalls?: Message['toolCalls'];
        toolResults?: PersistedToolResult[];
      };
      const toolResults = normalizePersistedToolResults(data.toolResults);
      const haystack = [
        data.content ?? '',
        data.contextContent ?? '',
        ...(data.toolCalls ?? []).flatMap((call) => [call.name, JSON.stringify(call.arguments)]),
        ...(toolResults ?? []).map((result) => result.content),
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
    const activeEventIds = new Set(this.load(id).activeEventIds);
    const byId = new Map(
      records
        .map((record, index) => [record.eventId ?? `legacy-line-${index + 1}`, record] as const)
        .filter(([eventId]) => activeEventIds.has(eventId)),
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
        toolResults?: PersistedToolResult[];
      };
      const toolResults = normalizePersistedToolResults(data.toolResults);
      let content: string;
      if (parsed.toolCallId) {
        const result = toolResults?.find((item) => item.toolCallId === parsed.toolCallId);
        if (!result) throw new Error(`Unknown tool-result reference: ${ref}`);
        content = clipHeadTail(
          result.content || result.structuredError?.message || '',
          TOOL_RESULT_PREVIEW_CHARS,
        );
      } else {
        content = JSON.stringify(
          {
            role: record.type,
            content: data.contextContent ?? data.content ?? '',
            toolCalls: data.toolCalls,
            toolResults: toolResults?.map((result) => ({
              ...result,
              content: clipHeadTail(result.content, TOOL_RESULT_PREVIEW_CHARS),
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

  listRewindTargets(id: string): RewindTarget[] {
    return this.load(id).rewindTargets;
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
    toolResults: normalizePersistedToolResults(message.toolResults),
    timestamp: message.timestamp ?? timestamp,
  };
}

function normalizePersistedToolResults(
  results: PersistedToolResult[] | undefined,
): Message['toolResults'] {
  return results?.map((result) => normalizeToolResult(result));
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

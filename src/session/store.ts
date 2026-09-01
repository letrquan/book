import {
  mkdirSync,
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  statSync,
  writeFileSync,
} from 'fs';
import { StringDecoder } from 'string_decoder';
import { join, normalize, resolve } from 'path';
import { createHash } from 'crypto';
import type {
  CompactBoundary,
  CompactRecordData,
  LoadedSession,
  PlanRecordData,
  UsageRecordData,
  RewindRecordData,
  RewindTarget,
  SessionHistorySearchResult,
  SessionMeta,
  SessionRecord,
  TurnCheckpointRecordData,
} from '../types/sessions.js';
import type { ImageAttachment, Message, Usage } from '../types/messages.js';
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
const SESSION_INDEX_FILE = 'session-index.json';
const JSONL_READ_BUFFER_BYTES = 64 * 1024;
const IMAGE_STORAGE_KEY = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/;

function imageSessionDirectory(root: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('Invalid attachment session id.');
  return join(root, 'attachments', sessionId);
}

interface SessionIndexEntry {
  meta: SessionMeta;
  lastMessageRole?: Message['role'];
  snapshotIds?: string[];
}

interface PersistedSessionIndex {
  version: 1;
  sessions: Record<string, SessionIndexEntry>;
}

interface ParsedSessionCache {
  size: number;
  mtimeMs: number;
  records: SessionRecord[];
  loaded?: LoadedSession;
  activeEventIds?: Set<string>;
  activeRecords?: IndexedSessionRecord[];
  recordsByActiveId?: Map<string, IndexedSessionRecord>;
}

interface IndexedSessionRecord {
  eventId: string;
  record: SessionRecord;
  searchText: string;
  displayText: string;
  toolResults?: Message['toolResults'];
}

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
  private readonly metadataIndex = new Map<string, SessionIndexEntry>();
  private readonly parsedSessions = new Map<string, ParsedSessionCache>();
  private indexInitialized = false;
  private buildingIndex = false;
  private indexMtimeMs = 0;

  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
    this.loadPersistedIndex();
  }

  saveImageAttachment(
    sessionId: string,
    image: { bytes: Uint8Array; mediaType: ImageAttachment['mediaType']; displayName?: string },
  ): ImageAttachment {
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    const extension = image.mediaType.slice('image/'.length).replace('jpeg', 'jpg');
    const storageKey = `${sha256}.${extension}`;
    const directory = imageSessionDirectory(this.root, sessionId);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, storageKey);
    if (!existsSync(path)) writeFileSync(path, image.bytes);
    return {
      id: crypto.randomUUID(),
      sha256,
      storageKey,
      mediaType: image.mediaType,
      byteSize: image.bytes.byteLength,
      ...(image.displayName ? { displayName: image.displayName } : {}),
    };
  }

  readImageAttachment(sessionId: string, attachment: ImageAttachment): Uint8Array {
    if (!IMAGE_STORAGE_KEY.test(attachment.storageKey)) {
      throw new Error(`Image attachment ${attachment.id} has an invalid storage key.`);
    }
    const path = join(imageSessionDirectory(this.root, sessionId), attachment.storageKey);
    const bytes = new Uint8Array(readFileSync(path));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== attachment.sha256) {
      throw new Error(`Image attachment ${attachment.id} failed integrity validation.`);
    }
    return bytes;
  }

  private path(id: string): string {
    return join(this.root, `${id}.jsonl`);
  }

  private indexPath(): string {
    return join(this.root, SESSION_INDEX_FILE);
  }

  private loadPersistedIndex(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath(), 'utf-8')) as PersistedSessionIndex;
      if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object') return;
      this.metadataIndex.clear();
      for (const [id, entry] of Object.entries(parsed.sessions)) {
        if (!entry?.meta || entry.meta.id !== id) continue;
        this.metadataIndex.set(id, entry);
      }
      this.indexMtimeMs = statSync(this.indexPath()).mtimeMs;
    } catch {
      // The index is a rebuildable acceleration structure.
    }
  }

  private readPersistedIndexEntries(): Record<string, SessionIndexEntry> {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath(), 'utf-8')) as PersistedSessionIndex;
      return parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object'
        ? parsed.sessions
        : {};
    } catch {
      return {};
    }
  }

  private persistIndex(deletedIds: string[] = [], changedIds?: string[]): void {
    if (this.buildingIndex) return;
    const lock = this.acquireIndexLock();
    try {
      const sessions = this.readPersistedIndexEntries();
      const ids = changedIds ?? Array.from(this.metadataIndex.keys());
      for (const id of ids) {
        const entry = this.metadataIndex.get(id);
        if (entry) sessions[id] = entry;
      }
      for (const id of deletedIds) delete sessions[id];
      const target = this.indexPath();
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, sessions }), 'utf-8');
        renameSync(temporary, target);
        this.indexMtimeMs = statSync(target).mtimeMs;
        this.metadataIndex.clear();
        for (const [id, entry] of Object.entries(sessions)) this.metadataIndex.set(id, entry);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    } finally {
      this.releaseIndexLock(lock);
    }
  }

  private acquireIndexLock(): number {
    const path = `${this.indexPath()}.lock`;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        return openSync(path, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(path).mtimeMs > 10_000) unlinkSync(path);
        } catch {
          // Another process may have released the lock.
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    throw new Error(`Timed out waiting for session index lock: ${path}`);
  }

  private releaseIndexLock(descriptor: number): void {
    closeSync(descriptor);
    try {
      unlinkSync(`${this.indexPath()}.lock`);
    } catch {
      // Stale-lock recovery may already have removed it.
    }
  }

  private ensureIndex(): void {
    if (this.indexInitialized) {
      try {
        if (statSync(this.indexPath()).mtimeMs !== this.indexMtimeMs) this.loadPersistedIndex();
      } catch {
        // A concurrently replaced index is retried on the next metadata operation.
      }
      return;
    }
    this.buildingIndex = true;
    let changed = false;
    try {
      const sessionIds = new Set(
        readdirSync(this.root)
          .filter((file) => file.endsWith('.jsonl'))
          .map((file) => file.replace(/\.jsonl$/, '')),
      );
      for (const id of this.metadataIndex.keys()) {
        if (!sessionIds.has(id)) {
          this.metadataIndex.delete(id);
          changed = true;
        }
      }
      for (const id of sessionIds) {
        if (this.metadataIndex.has(id)) continue;
        try {
          this.load(id);
          changed = true;
        } catch {
          // Skip corrupt session files while retaining other index entries.
        }
      }
    } finally {
      this.buildingIndex = false;
      this.indexInitialized = true;
    }
    if (changed || !existsSync(this.indexPath())) this.persistIndex();
  }

  private setIndexEntry(
    meta: SessionMeta,
    lastMessageRole?: Message['role'],
    snapshotIds = this.metadataIndex.get(meta.id)?.snapshotIds ?? [],
  ): void {
    const next = { meta: { ...meta }, lastMessageRole, snapshotIds } satisfies SessionIndexEntry;
    const current = this.metadataIndex.get(meta.id);
    if (current && JSON.stringify(current) === JSON.stringify(next)) return;
    this.metadataIndex.set(meta.id, next);
    this.persistIndex([], [meta.id]);
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
    this.setIndexEntry(header.data as SessionMeta);
    return id;
  }

  append(id: string, record: SessionRecord): void {
    const serialized = JSON.stringify(record) + '\n';
    appendFileSync(this.path(id), serialized, 'utf-8');
    const cached = this.parsedSessions.get(id);
    if (cached) {
      const stat = statSync(this.path(id));
      cached.records.push(record);
      cached.size = stat.size;
      cached.mtimeMs = stat.mtimeMs;
      cached.loaded = undefined;
      cached.activeEventIds = undefined;
      cached.activeRecords = undefined;
      cached.recordsByActiveId = undefined;
    }
    this.updateIndexAfterAppend(id, record);
  }

  readRecords(id: string): SessionRecord[] {
    const p = this.path(id);
    if (!existsSync(p)) throw new Error(`Session not found: ${id}`);
    const stat = statSync(p);
    const cached = this.parsedSessions.get(id);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.records;
    }
    const records: SessionRecord[] = [];
    const descriptor = openSync(p, 'r');
    const buffer = Buffer.allocUnsafe(JSONL_READ_BUFFER_BYTES);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let lineNumber = 0;
    const parseLine = (line: string) => {
      lineNumber++;
      if (!line) return;
      try {
        records.push(JSON.parse(line) as SessionRecord);
      } catch {
        log.warn('ignoring corrupt session record', { id, line: lineNumber });
      }
    };
    try {
      let bytesRead: number;
      while ((bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null)) > 0) {
        pending += decoder.write(buffer.subarray(0, bytesRead));
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          parseLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      }
      pending += decoder.end();
      if (pending) parseLine(pending);
    } finally {
      closeSync(descriptor);
    }
    this.parsedSessions.set(id, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      records,
    });
    return records;
  }

  private updateIndexAfterAppend(id: string, record: SessionRecord): void {
    const entry = this.metadataIndex.get(id);
    if (!entry) {
      try {
        this.load(id);
      } catch {
        // A corrupt append target remains discoverable through a later index rebuild.
      }
      return;
    }

    const data = (record.data ?? {}) as {
      kind?: string;
      name?: string;
      content?: string;
      complete?: boolean;
    };
    entry.meta.updatedAt = record.timestamp;
    if (data.kind === 'session_meta_patch') {
      if (Object.prototype.hasOwnProperty.call(data, 'name')) entry.meta.name = data.name;
    } else if (record.type === 'user') {
      entry.meta.messageCount++;
      entry.lastMessageRole = 'user';
      if (!entry.meta.name && data.content) entry.meta.name = deriveSessionName(data.content);
    } else if (record.type === 'local') {
      entry.meta.messageCount++;
      entry.lastMessageRole = 'assistant';
    } else if (record.type === 'assistant') {
      if (data.complete || entry.lastMessageRole !== 'assistant') entry.meta.messageCount++;
      entry.lastMessageRole = 'assistant';
    } else if (record.type === 'turn_checkpoint') {
      const snapshotId = (record.data as TurnCheckpointRecordData)?.checkpoint?.snapshotId;
      if (snapshotId && !entry.snapshotIds?.includes(snapshotId)) {
        entry.snapshotIds = [...(entry.snapshotIds ?? []), snapshotId];
      }
    } else if (record.type === 'rewind') {
      const loaded = this.load(id);
      this.setIndexEntry(loaded.meta, loaded.transcript.at(-1)?.role);
      return;
    }
    this.persistIndex([], [id]);
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
    const parsedCache = this.parsedSessions.get(id);
    if (parsedCache?.loaded) return cloneLoadedSession(parsedCache.loaded);

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
    let contextHistory: Message[] = [];
    const compactBoundaries: CompactBoundary[] = [];
    let activeEventTail: ReplayLink<string> | undefined;
    let activeTargetTail: ReplayLink<string> | undefined;
    const targets = new Map<string, RewindTarget>();
    const targetStates = new Map<
      string,
      {
        transcriptLength: number;
        contextHistory: Message[];
        contextHistoryLength: number;
        compactBoundariesLength: number;
        activeEventTail?: ReplayLink<string>;
        activeTargetTail?: ReplayLink<string>;
        count: number;
      }
    >();
    const checkpointByUserEventId = new Map<string, string>();
    const snapshotIds = new Set<string>();
    let latestPlan: PlanRecordData | undefined;
    let carriedUsage: Usage | undefined;
    const carriedModels = new Set<string>();
    let count = 0;
    for (let lineIndex = 0; lineIndex < records.length; lineIndex++) {
      const record = records[lineIndex];
      const eventId = record.eventId ?? `legacy-line-${lineIndex + 1}`;
      const data = record.data as {
        kind?: string;
        name?: string;
        content?: string;
        reasoningContent?: string;
        providerMetadata?: Message['providerMetadata'];
        contextContent?: string;
        derivedContent?: boolean;
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
        attachments?: Message['attachments'];
      };

      if (data.kind === 'session_meta_patch') {
        if (Object.prototype.hasOwnProperty.call(data, 'name')) meta.name = data.name;
        continue;
      }
      if (data.kind === 'session_meta' || data.kind === 'session_touch') continue;

      if (record.type === 'usage') {
        const entry = record.data as UsageRecordData;
        if (entry?.version === 1 && entry.usage) {
          carriedUsage = {
            promptTokens: (carriedUsage?.promptTokens ?? 0) + (entry.usage.promptTokens ?? 0),
            completionTokens:
              (carriedUsage?.completionTokens ?? 0) + (entry.usage.completionTokens ?? 0),
            totalTokens: (carriedUsage?.totalTokens ?? 0) + (entry.usage.totalTokens ?? 0),
            cacheCreationInputTokens:
              (carriedUsage?.cacheCreationInputTokens ?? 0) +
              (entry.usage.cacheCreationInputTokens ?? 0),
            cacheReadInputTokens:
              (carriedUsage?.cacheReadInputTokens ?? 0) + (entry.usage.cacheReadInputTokens ?? 0),
          };
          const model = entry.responseModel ?? entry.requestedModel;
          if (model) carriedModels.add(model);
        }
        continue;
      }

      if (record.type === 'plan') {
        // Last record wins: each write is a whole-plan snapshot, so replaying to
        // the end yields the newest plan without merging. A malformed record is
        // skipped rather than clearing a good earlier one.
        const plan = record.data as PlanRecordData;
        if (plan?.version === 1) latestPlan = plan;
        continue;
      }

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
          attachments: checkpoint.attachments,
          timestamp: record.timestamp,
          ...checkpoint.checkpoint,
          codeAvailable: Boolean(
            checkpoint.checkpoint.snapshotId && !checkpoint.checkpoint.codeUnavailableReason,
          ),
        };
        targets.set(target.id, target);
        if (checkpoint.checkpoint.snapshotId) snapshotIds.add(checkpoint.checkpoint.snapshotId);
        targetStates.set(target.id, {
          transcriptLength: transcript.length,
          contextHistory,
          contextHistoryLength: contextHistory.length,
          compactBoundariesLength: compactBoundaries.length,
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
          transcript.length = state.transcriptLength;
          contextHistory = state.contextHistory;
          contextHistory.length = state.contextHistoryLength;
          compactBoundaries.length = state.compactBoundariesLength;
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
        compactBoundaries.push(boundary);
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
            attachments: data.attachments,
            timestamp: record.timestamp,
            codeAvailable: false,
            codeUnavailableReason: 'No filesystem checkpoint was captured for this turn.',
          };
          targets.set(targetId, legacyTarget);
          targetStates.set(targetId, {
            transcriptLength: transcript.length,
            contextHistory,
            contextHistoryLength: contextHistory.length,
            compactBoundariesLength: compactBoundaries.length,
            activeEventTail,
            activeTargetTail,
            count,
          });
        } else if (data.attachments?.length) {
          const target = targets.get(targetId);
          if (target && !target.attachments?.length) target.attachments = data.attachments;
        }
        count++;
        const message: Message = {
          id: data.id ?? eventId,
          role: 'user',
          content: data.content ?? '',
          contextContent: data.contextContent,
          derivedContent: data.derivedContent,
          includeInContext: data.includeInContext ?? true,
          kind: (data.kind as Message['kind']) ?? 'conversation',
          agentNotifications: data.agentNotifications,
          attachments: data.attachments,
          fileObservations: data.fileObservations,
          timestamp: record.timestamp,
        };
        transcript.push(message);
        if (message.includeInContext) contextHistory.push(message);
        activeEventTail = appendReplayLink(activeEventTail, eventId);
        activeTargetTail = appendReplayLink(activeTargetTail, targetId);
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
        activeEventTail = appendReplayLink(activeEventTail, eventId);
      } else if (record.type === 'assistant') {
        if (data.complete) {
          count++;
          const message: Message = {
            id: data.id ?? eventId,
            role: 'assistant',
            content: data.content ?? '',
            reasoningContent: data.reasoningContent,
            providerMetadata: data.providerMetadata,
            contextContent: data.contextContent,
            includeInContext: data.includeInContext ?? true,
            kind: (data.kind as Message['kind']) ?? 'conversation',
            agentNotifications: data.agentNotifications,
            attachments: data.attachments,
            toolCalls: data.toolCalls,
            toolResults: normalizePersistedToolResults(data.toolResults),
            fileObservations: data.fileObservations,
            timestamp: record.timestamp,
          };
          transcript.push(message);
          if (message.includeInContext) contextHistory.push(message);
          activeEventTail = appendReplayLink(activeEventTail, eventId);
        } else {
          const last = transcript[transcript.length - 1];
          if (last?.role === 'assistant') {
            const updated = {
              ...last,
              content: last.content + (data.content ?? ''),
              reasoningContent:
                (last.reasoningContent ?? '') + (data.reasoningContent ?? '') || undefined,
              providerMetadata: data.providerMetadata ?? last.providerMetadata,
            };
            transcript[transcript.length - 1] = updated;
            const contextLast = contextHistory[contextHistory.length - 1];
            if (contextLast?.id === last.id) {
              contextHistory[contextHistory.length - 1] = updated;
            }
          } else {
            count++;
            const message: Message = {
              id: data.id ?? eventId,
              role: 'assistant',
              content: data.content ?? '',
              reasoningContent: data.reasoningContent,
              providerMetadata: data.providerMetadata,
              includeInContext: true,
              kind: 'conversation',
              timestamp: record.timestamp,
            };
            transcript.push(message);
            contextHistory.push(message);
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
    const loaded: LoadedSession = {
      transcript,
      contextHistory,
      compactBoundaries,
      rewindTargets,
      activeEventIds,
      meta,
      plan: latestPlan,
      carriedUsage,
      carriedModels: [...carriedModels],
      history: contextHistory,
    };
    if (parsedCache) parsedCache.loaded = loaded;
    if (parsedCache) {
      parsedCache.activeEventIds = new Set(activeEventIds);
      parsedCache.activeRecords = undefined;
      parsedCache.recordsByActiveId = undefined;
    }
    this.setIndexEntry(meta, transcript.at(-1)?.role, [...snapshotIds]);
    return cloneLoadedSession(loaded);
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
    const sourceAttachments = imageSessionDirectory(this.root, sourceId);
    if (existsSync(sourceAttachments)) {
      const targetAttachments = imageSessionDirectory(this.root, targetId);
      mkdirSync(targetAttachments, { recursive: true });
      for (const filename of readdirSync(sourceAttachments)) {
        copyFileSync(join(sourceAttachments, filename), join(targetAttachments, filename));
      }
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
    for (const indexed of this.activeRecordIndex(id)) {
      const { eventId, record, searchText, displayText } = indexed;
      if (!['user', 'assistant', 'local'].includes(record.type)) continue;
      if (!searchText.includes(needle)) continue;
      results.push({
        ref: `session://current/event/${eventId}`,
        role: record.type === 'user' ? 'user' : 'assistant',
        preview: clipPreview(displayText, SEARCH_PREVIEW_CHARS),
        timestamp: record.timestamp,
      });
      if (results.length >= capped) break;
    }
    return results;
  }

  readCurrent(id: string, refs: string[]): Array<{ ref: string; content: string }> {
    if (refs.length > READ_REF_LIMIT)
      throw new Error(`At most ${READ_REF_LIMIT} references per call.`);
    const byId = this.activeRecordMap(id);
    const output: Array<{ ref: string; content: string }> = [];
    let remaining = READ_TOTAL_CHARS;
    for (const ref of refs) {
      const parsed = parseCurrentSessionRef(ref);
      const indexed = byId.get(parsed.eventId);
      if (!indexed) throw new Error(`Unknown session history reference: ${ref}`);
      const record = indexed.record;
      const data = record.data as {
        content?: string;
        contextContent?: string;
        toolCalls?: Message['toolCalls'];
        toolResults?: PersistedToolResult[];
      };
      const toolResults = indexed.toolResults;
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

  private activeRecordIndex(id: string): IndexedSessionRecord[] {
    let cache = this.parsedSessions.get(id);
    if (!cache?.activeEventIds) {
      this.load(id);
      cache = this.parsedSessions.get(id);
    }
    if (!cache) return [];
    if (cache.activeRecords) return cache.activeRecords;
    const activeEventIds = cache.activeEventIds ?? new Set<string>();
    cache.activeRecords = cache.records.flatMap((record, index) => {
      const eventId = record.eventId ?? `legacy-line-${index + 1}`;
      if (!activeEventIds.has(eventId)) return [];
      const data = record.data as {
        content?: string;
        contextContent?: string;
        toolCalls?: Message['toolCalls'];
        toolResults?: PersistedToolResult[];
      };
      const toolResults = normalizePersistedToolResults(data.toolResults);
      const displayText = [
        data.content ?? '',
        data.contextContent ?? '',
        ...(data.toolCalls ?? []).flatMap((call) => [call.name, JSON.stringify(call.arguments)]),
        ...(toolResults ?? []).map((result) => result.content),
      ].join('\n');
      return [{ eventId, record, displayText, searchText: displayText.toLowerCase(), toolResults }];
    });
    return cache.activeRecords;
  }

  private activeRecordMap(id: string): Map<string, IndexedSessionRecord> {
    const cache = this.parsedSessions.get(id);
    if (cache?.recordsByActiveId) return cache.recordsByActiveId;
    const records = this.activeRecordIndex(id);
    const refreshed = this.parsedSessions.get(id);
    const byId = new Map(records.map((record) => [record.eventId, record]));
    if (refreshed) refreshed.recordsByActiveId = byId;
    return byId;
  }

  list(): SessionMeta[] {
    this.ensureIndex();
    return Array.from(this.metadataIndex.values(), (entry) => ({ ...entry.meta })).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  listRewindTargets(id: string): RewindTarget[] {
    return this.load(id).rewindTargets;
  }

  listSnapshotReferences(cwd: string): Set<string> {
    const normalized = normalizeWorkspace(cwd);
    this.ensureIndex();
    const references = new Set<string>();
    for (const entry of this.metadataIndex.values()) {
      if (entry.meta.cwd !== normalized) continue;
      for (const snapshotId of entry.snapshotIds ?? []) references.add(snapshotId);
    }
    return references;
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

  cleanup(days: number, preserveIds: ReadonlySet<string> = new Set()): number {
    const cutoff = Date.now() - days * 86400_000;
    let removed = 0;
    const removedIds: string[] = [];
    this.ensureIndex();
    for (const [id, entry] of this.metadataIndex) {
      if (preserveIds.has(id)) continue;
      try {
        if (entry.meta.updatedAt < cutoff) {
          unlinkSync(this.path(id));
          rmSync(imageSessionDirectory(this.root, id), { recursive: true, force: true });
          this.metadataIndex.delete(id);
          this.parsedSessions.delete(id);
          removedIds.push(id);
          removed++;
        }
      } catch {
        if (existsSync(this.path(id)) && statSync(this.path(id)).mtimeMs < cutoff) {
          unlinkSync(this.path(id));
          rmSync(imageSessionDirectory(this.root, id), { recursive: true, force: true });
          this.metadataIndex.delete(id);
          this.parsedSessions.delete(id);
          removedIds.push(id);
          removed++;
        }
      }
    }
    if (removedIds.length > 0) this.persistIndex(removedIds, []);
    return removed;
  }
}

function cloneLoadedSession(session: LoadedSession): LoadedSession {
  const contextHistory = [...session.contextHistory];
  return {
    transcript: [...session.transcript],
    contextHistory,
    compactBoundaries: [...session.compactBoundaries],
    rewindTargets: [...session.rewindTargets],
    activeEventIds: [...session.activeEventIds],
    meta: { ...session.meta },
    plan: session.plan
      ? {
          version: 1,
          todos: session.plan.todos?.map((todo) => ({ ...todo })),
          tasks: session.plan.tasks?.map((task) => ({ ...task })),
        }
      : undefined,
    carriedUsage: session.carriedUsage ? { ...session.carriedUsage } : undefined,
    carriedModels: session.carriedModels ? [...session.carriedModels] : undefined,
    history: contextHistory,
  };
}

function restoreMessage(message: Message, fallbackId: string, timestamp: number): Message {
  return {
    ...message,
    id: message.id || fallbackId,
    content: message.content ?? '',
    includeInContext: message.includeInContext ?? true,
    kind: message.kind ?? (message.includeInContext === false ? 'local' : 'conversation'),
    toolResults: normalizePersistedToolResults(message.toolResults),
    attachments: message.attachments,
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

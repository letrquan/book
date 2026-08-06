import { createHash } from 'node:crypto';
import type { CompactBoundary } from '../types/sessions.js';
import type { Message } from '../types/messages.js';
import { estimateHistoryTokens } from './compact.js';
import { createPaperZeroMemModel, type LoadedPaperZeroMemModel } from './zero-mem-models.js';
import {
  ZeroMemIndex,
  renderZeroMemTrace,
  type ZeroMemOptions,
  type ZeroMemResult,
  type ZeroMemTraceMetadata,
} from './zero-mem.js';

export interface ZeroMemRuntimeOptions {
  loadModel?: () => Promise<LoadedPaperZeroMemModel>;
  topK?: number;
  closureK?: number;
  recentTailMessages?: number;
}

export interface ZeroMemWarmResult {
  sourceMessages: number;
  indexedMessages: number;
  loadMs: number;
  indexMs: number;
  semanticModel?: string;
}

export interface ZeroMemPreparedHistory extends ZeroMemWarmResult {
  history: Message[];
  retrieval?: ZeroMemResult;
}

export interface ZeroMemPrepareRequest {
  transcript: readonly Message[];
  query: string;
  sessionId: string;
  compactBoundaries?: readonly CompactBoundary[];
  currentMessageId?: string;
  timestamp?: number;
  maxContextTokens?: number;
}

function defaultModelLoader(): Promise<LoadedPaperZeroMemModel> {
  const localFilesOnly = process.env.BOOK_ZERO_MEM_LOCAL_FILES_ONLY !== 'false';
  return createPaperZeroMemModel({ localFilesOnly });
}

function isStableSource(message: Message, currentMessageId?: string): boolean {
  return (
    message.id !== currentMessageId &&
    message.includeInContext &&
    message.kind !== 'local' &&
    message.kind !== 'checkpoint' &&
    message.kind !== 'agent-notification' &&
    renderZeroMemTrace(message).trim().length > 0
  );
}

function boundaryForOrdinal(
  ordinal: number,
  boundaries: readonly CompactBoundary[],
): string | undefined {
  let boundaryId: string | undefined;
  for (const boundary of boundaries) {
    if (boundary.transcriptOrdinal > ordinal) break;
    boundaryId = boundary.id;
  }
  return boundaryId;
}

function signature(message: Message, metadata: ZeroMemTraceMetadata): string {
  return createHash('sha256')
    .update(message.id)
    .update('\0')
    .update(message.role)
    .update('\0')
    .update(String(message.timestamp))
    .update('\0')
    .update(metadata.sessionId ?? '')
    .update('\0')
    .update(metadata.boundaryId ?? '')
    .update('\0')
    .update(renderZeroMemTrace(message))
    .digest('hex');
}

function recentTail(source: readonly Message[], count: number, maxTokens?: number): Message[] {
  if (count <= 0) return [];
  let start = Math.max(0, source.length - count);
  while (start > 0 && source[start]?.role !== 'user') start--;
  const candidates = source.slice(start);
  if (!maxTokens) return candidates;

  const selected: Message[] = [];
  for (const message of [...candidates].reverse()) {
    const next = [message, ...selected];
    if (selected.length > 0 && estimateHistoryTokens(next) > maxTokens) continue;
    selected.unshift(message);
  }
  return selected;
}

/** Session-scoped model and index cache used by production Zero-Mem context preparation. */
export class ZeroMemRuntime {
  private readonly loadModel: () => Promise<LoadedPaperZeroMemModel>;
  private readonly options: Pick<ZeroMemOptions, 'topK' | 'closureK'>;
  private readonly recentTailMessages: number;
  private readonly metadata = new Map<string, ZeroMemTraceMetadata>();
  private modelRuntime?: LoadedPaperZeroMemModel;
  private modelPromise?: Promise<LoadedPaperZeroMemModel>;
  private index?: ZeroMemIndex;
  private source: Message[] = [];
  private signatures: string[] = [];

  constructor(options: ZeroMemRuntimeOptions = {}) {
    this.loadModel = options.loadModel ?? defaultModelLoader;
    this.options = { topK: options.topK ?? 5, closureK: options.closureK ?? 2 };
    this.recentTailMessages = Math.max(0, Math.floor(options.recentTailMessages ?? 4));
  }

  async warm(
    transcript: readonly Message[],
    sessionId: string,
    compactBoundaries: readonly CompactBoundary[] = [],
  ): Promise<ZeroMemWarmResult> {
    await this.synchronize(transcript, sessionId, compactBoundaries);
    return this.status();
  }

  async prepare(request: ZeroMemPrepareRequest): Promise<ZeroMemPreparedHistory> {
    await this.synchronize(
      request.transcript,
      request.sessionId,
      request.compactBoundaries ?? [],
      request.currentMessageId,
    );
    if (!this.index) return { ...this.status(), history: [] };

    const built = await this.index.buildHistory(request.query, {
      sessionId: request.sessionId,
      timestamp: request.timestamp,
      maxContextTokens: request.maxContextTokens,
    });
    const tail = recentTail(
      this.source,
      this.recentTailMessages,
      request.maxContextTokens
        ? Math.max(1, Math.floor(request.maxContextTokens * 0.35))
        : undefined,
    );
    return {
      ...this.status(),
      history: [...(built.result.evidence.length > 0 ? built.history : []), ...tail],
      retrieval: built.result,
    };
  }

  private async synchronize(
    transcript: readonly Message[],
    sessionId: string,
    compactBoundaries: readonly CompactBoundary[],
    currentMessageId?: string,
  ): Promise<void> {
    const orderedBoundaries = [...compactBoundaries].sort(
      (left, right) => left.transcriptOrdinal - right.transcriptOrdinal,
    );
    const source: Message[] = [];
    const metadata = new Map<string, ZeroMemTraceMetadata>();
    const signatures: string[] = [];
    for (let ordinal = 0; ordinal < transcript.length; ordinal++) {
      const message = transcript[ordinal]!;
      if (!isStableSource(message, currentMessageId)) continue;
      const traceMetadata: ZeroMemTraceMetadata = {
        sessionId,
        boundaryId: boundaryForOrdinal(ordinal, orderedBoundaries),
        eventTime: message.timestamp,
      };
      source.push(message);
      metadata.set(message.id, traceMetadata);
      signatures.push(signature(message, traceMetadata));
    }

    if (source.length === 0) {
      this.index = undefined;
      this.source = [];
      this.signatures = [];
      this.metadata.clear();
      return;
    }

    const prefixMatches = this.signatures.every(
      (value, index) => signatures[index] === value && this.source[index]?.id === source[index]?.id,
    );
    const appendOnly = prefixMatches && source.length >= this.source.length;
    this.metadata.clear();
    for (const [id, value] of metadata) this.metadata.set(id, value);

    const modelRuntime = await this.ensureModel();
    if (!this.index || !appendOnly) {
      this.index = await ZeroMemIndex.create(source, {
        semanticModel: modelRuntime.model,
        traceMetadata: this.metadata,
        ...this.options,
      });
    } else if (source.length > this.source.length) {
      await this.index.append(source.slice(this.source.length));
    }
    this.source = source;
    this.signatures = signatures;
  }

  private async ensureModel(): Promise<LoadedPaperZeroMemModel> {
    if (this.modelRuntime) return this.modelRuntime;
    this.modelPromise ??= this.loadModel();
    try {
      this.modelRuntime = await this.modelPromise;
      return this.modelRuntime;
    } catch (error) {
      this.modelPromise = undefined;
      const detail = error instanceof Error ? error.message : String(error);
      const hint =
        process.env.BOOK_ZERO_MEM_LOCAL_FILES_ONLY === 'false'
          ? ''
          : ' Set BOOK_ZERO_MEM_LOCAL_FILES_ONLY=false once to permit downloading the model cache, or select compactStrategy=summary.';
      throw new Error(`Zero-Mem semantic models are unavailable.${hint} ${detail}`.trim());
    }
  }

  private status(): ZeroMemWarmResult {
    return {
      sourceMessages: this.source.length,
      indexedMessages: this.signatures.length,
      loadMs: this.modelRuntime?.loadMs ?? 0,
      indexMs: this.index?.indexMs ?? 0,
      semanticModel: this.modelRuntime?.model.name,
    };
  }

  async dispose(): Promise<void> {
    const modelRuntime = this.modelRuntime;
    this.modelRuntime = undefined;
    this.modelPromise = undefined;
    this.index = undefined;
    this.source = [];
    this.signatures = [];
    this.metadata.clear();
    await modelRuntime?.dispose();
  }
}

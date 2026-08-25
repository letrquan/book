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

class ZeroMemRuntimeDisposedError extends Error {
  constructor(options?: ErrorOptions) {
    super('Zero-Mem runtime was disposed.', options);
    this.name = 'ZeroMemRuntimeDisposedError';
  }
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
  private generation = 0;
  private disposed = false;
  private operationQueue: Promise<void> = Promise.resolve();
  private disposePromise?: Promise<void>;

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
    return this.runExclusive(async (generation) => {
      await this.synchronize(transcript, sessionId, compactBoundaries, generation);
      this.assertActive(generation);
      return this.status();
    });
  }

  async prepare(request: ZeroMemPrepareRequest): Promise<ZeroMemPreparedHistory> {
    return this.runExclusive(async (generation) => {
      await this.synchronize(
        request.transcript,
        request.sessionId,
        request.compactBoundaries ?? [],
        generation,
        request.currentMessageId,
      );
      this.assertActive(generation);
      if (!this.index) return { ...this.status(), history: [] };

      const built = await this.index.buildHistory(request.query, {
        sessionId: request.sessionId,
        timestamp: request.timestamp,
        maxContextTokens: request.maxContextTokens,
      });
      this.assertActive(generation);
      const tail = recentTail(
        this.source,
        this.recentTailMessages,
        request.maxContextTokens
          ? Math.max(1, Math.floor(request.maxContextTokens * 0.35))
          : undefined,
      );
      return {
        ...this.status(),
        history: [...built.history, ...tail],
        retrieval: built.result,
      };
    });
  }

  private async synchronize(
    transcript: readonly Message[],
    sessionId: string,
    compactBoundaries: readonly CompactBoundary[],
    generation: number,
    currentMessageId?: string,
  ): Promise<void> {
    this.assertActive(generation);
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

    const modelRuntime = await this.ensureModel(generation);
    this.assertActive(generation);
    if (!this.index || !appendOnly) {
      const index = await ZeroMemIndex.create(source, {
        semanticModel: modelRuntime.model,
        traceMetadata: this.metadata,
        ...this.options,
      });
      this.assertActive(generation);
      this.index = index;
    } else if (source.length > this.source.length) {
      await this.index.append(source.slice(this.source.length));
      this.assertActive(generation);
    }
    this.source = source;
    this.signatures = signatures;
  }

  private async ensureModel(generation: number): Promise<LoadedPaperZeroMemModel> {
    this.assertActive(generation);
    if (this.modelRuntime) return this.modelRuntime;
    let modelPromise: Promise<LoadedPaperZeroMemModel> | undefined;
    try {
      modelPromise =
        this.modelPromise ??
        (this.modelPromise = this.loadModel().then(async (modelRuntime) => {
          if (this.disposed || generation !== this.generation) {
            try {
              await modelRuntime.dispose();
            } catch (cause) {
              throw new ZeroMemRuntimeDisposedError({ cause });
            }
            throw new ZeroMemRuntimeDisposedError();
          }
          this.modelRuntime = modelRuntime;
          return modelRuntime;
        }));
      return await modelPromise;
    } catch (error) {
      if (modelPromise && this.modelPromise === modelPromise) this.modelPromise = undefined;
      if (error instanceof ZeroMemRuntimeDisposedError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      const hint =
        process.env.BOOK_ZERO_MEM_LOCAL_FILES_ONLY === 'false'
          ? ''
          : ' Set BOOK_ZERO_MEM_LOCAL_FILES_ONLY=false once to permit downloading the model cache, or disable experimental.zeroMem.';
      throw new Error(`Zero-Mem semantic models are unavailable.${hint} ${detail}`.trim());
    }
  }

  private runExclusive<T>(operation: (generation: number) => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(async () => {
      const generation = this.generation;
      this.assertActive(generation);
      return operation(generation);
    });
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertActive(generation: number): void {
    if (this.disposed || generation !== this.generation) {
      throw new ZeroMemRuntimeDisposedError();
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

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.generation++;
    const pendingOperations = this.operationQueue;
    this.disposePromise = (async () => {
      await pendingOperations;
      const modelRuntime = this.modelRuntime;
      this.modelRuntime = undefined;
      this.modelPromise = undefined;
      this.index = undefined;
      this.source = [];
      this.signatures = [];
      this.metadata.clear();
      await modelRuntime?.dispose();
    })();
    return this.disposePromise;
  }
}

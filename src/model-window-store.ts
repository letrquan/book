import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveBookHome } from './book-home.js';
import { writeFileAtomic } from './settings-repository.js';

export const MODEL_WINDOW_STORE_VERSION = 1;

/**
 * Fraction of the refused prompt history recorded as the learned window ceiling.
 *
 * When a provider rejects a request for exceeding the context limit, the history
 * tokens at that moment represent a size that was REFUSED, not a size the provider
 * accepts. Recording the refused size directly would set a ceiling larger than the
 * true context window (e.g. true window 100k, refused history 150k -> ceiling 150k),
 * causing repeated user-visible failures. Applying a safety margin ensures the
 * recorded ceiling is strictly below the refused size and converges rapidly to a
 * viable operating limit.
 */
export const LEARNED_WINDOW_SAFETY_MARGIN = 0.8;

/**
 * Minimum context window ceiling recorded from an overflow refusal.
 *
 * Sane coding sessions require at least 16k tokens for tools, system prompt,
 * and working context. Any refusal below this floor is far more likely to be an
 * upstream proxy error (e.g. 413 Request Entity Too Large) or bad telemetry
 * than a real context limit. Refusals below this floor are ignored rather than
 * recorded, preventing a transient error from permanently bricking the model.
 */
export const MIN_LEARNED_CONTEXT_WINDOW = 16_384;

export interface LearnedModelWindowEntry {
  contextWindow: number;
  learnedAt: number;
}

export interface ModelWindowStoreData {
  version: number;
  models: Record<string, LearnedModelWindowEntry>;
}

export interface ModelWindowStoreOptions {
  /** Explicit BOOK_HOME directory root (used by tests to isolate storage). */
  home?: string;
  /** Explicit file path override (used by tests). */
  path?: string;
  /** Optional clock override for timestamps (used by tests). */
  now?: () => number;
}

export interface ModelWindowStore {
  get(model: string): number | undefined;
  getEntry(model: string): LearnedModelWindowEntry | undefined;
  ratchet(model: string, ceiling: number): boolean;
  all(): Record<string, LearnedModelWindowEntry>;
}

const learnedModelWindowEntrySchema = z.object({
  contextWindow: z.number().int().positive(),
  learnedAt: z.number().int().nonnegative(),
});

const looseModelWindowStoreSchema = z.object({
  version: z.number().int().positive().default(MODEL_WINDOW_STORE_VERSION),
  models: z.record(z.unknown()).default({}),
});

function emptyStore(): ModelWindowStoreData {
  return { version: MODEL_WINDOW_STORE_VERSION, models: {} };
}

/**
 * Resolved location for the user-global learned-window store.
 *
 * This file lives under BOOK_HOME (e.g. ~/.book/model-windows.json), NEVER inside
 * the workspace. A repository must never be able to declare or tamper with
 * learned window ceilings for itself.
 */
export function defaultModelWindowStorePath(home?: string): string {
  return home ? join(home, 'model-windows.json') : join(resolveBookHome(), 'model-windows.json');
}

/**
 * Read the learned-window store.
 * Tolerates missing, empty, or corrupt files by returning an empty store.
 * Never throws into a run.
 */
export function readModelWindowStore(options?: ModelWindowStoreOptions): ModelWindowStoreData {
  const filePath = options?.path ?? defaultModelWindowStorePath(options?.home);
  if (!existsSync(filePath)) {
    return emptyStore();
  }
  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw);
    const validated = looseModelWindowStoreSchema.safeParse(parsed);
    if (!validated.success) {
      return emptyStore();
    }
    const models: Record<string, LearnedModelWindowEntry> = {};
    for (const [key, value] of Object.entries(validated.data.models)) {
      const entryResult = learnedModelWindowEntrySchema.safeParse(value);
      if (entryResult.success) {
        models[key] = entryResult.data;
      }
    }
    return {
      version: validated.data.version,
      models,
    };
  } catch {
    return emptyStore();
  }
}

/**
 * Atomically persist the learned-window store.
 * Never throws into a run.
 */
export function writeModelWindowStore(
  data: ModelWindowStoreData,
  options?: ModelWindowStoreOptions,
): boolean {
  if (data.version > MODEL_WINDOW_STORE_VERSION) {
    return false;
  }
  const filePath = options?.path ?? defaultModelWindowStorePath(options?.home);
  try {
    if (existsSync(filePath)) {
      const existing = readModelWindowStore(options);
      if (existing.version > MODEL_WINDOW_STORE_VERSION) {
        return false;
      }
    }
    const serialized = JSON.stringify(data, null, 2) + '\n';
    writeFileAtomic(filePath, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Records a learned context window ceiling for a model.
 *
 * Ratchet, downward only:
 * - If no entry exists for the model, records the new ceiling.
 * - If an entry exists with a larger ceiling, lowers it.
 * - If an entry exists with an equal or smaller ceiling, changes nothing.
 *
 * Monotonicity is strict: a later overflow at a smaller size lowers it further;
 * an overflow at a larger size does not raise it.
 *
 * Returns true if the store was updated with a new ceiling, false otherwise.
 */
export function ratchetModelWindow(
  model: string,
  ceiling: number,
  options?: ModelWindowStoreOptions,
): boolean {
  return createModelWindowStore(options).ratchet(model, ceiling);
}

/**
 * File-backed implementation of ModelWindowStore.
 * Delegates to createModelWindowStore for closure-based, freeze-safe caching.
 */
export class FileModelWindowStore implements ModelWindowStore {
  private readonly inner: ModelWindowStore;

  constructor(options?: ModelWindowStoreOptions) {
    this.inner = createModelWindowStore(options);
  }

  get(model: string): number | undefined {
    return this.inner.get(model);
  }

  getEntry(model: string): LearnedModelWindowEntry | undefined {
    return this.inner.getEntry(model);
  }

  ratchet(model: string, ceiling: number): boolean {
    return this.inner.ratchet(model, ceiling);
  }

  all(): Record<string, LearnedModelWindowEntry> {
    return this.inner.all();
  }
}

/**
 * In-memory implementation of ModelWindowStore, useful for unit tests.
 */
export class MemoryModelWindowStore implements ModelWindowStore {
  private readonly models = new Map<string, LearnedModelWindowEntry>();
  private readonly now: () => number;

  constructor(initial?: Record<string, LearnedModelWindowEntry>, now = Date.now) {
    this.now = now;
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.models.set(k, { ...v });
      }
    }
  }

  get(model: string): number | undefined {
    return this.models.get(model)?.contextWindow;
  }

  getEntry(model: string): LearnedModelWindowEntry | undefined {
    const entry = this.models.get(model);
    return entry ? { ...entry } : undefined;
  }

  ratchet(model: string, ceiling: number): boolean {
    if (
      !model ||
      typeof ceiling !== 'number' ||
      !Number.isFinite(ceiling) ||
      ceiling < MIN_LEARNED_CONTEXT_WINDOW
    ) {
      return false;
    }
    const normalized = Math.floor(ceiling);
    const existing = this.models.get(model);
    if (existing && existing.contextWindow <= normalized) {
      return false;
    }
    this.models.set(model, { contextWindow: normalized, learnedAt: this.now() });
    return true;
  }

  all(): Record<string, LearnedModelWindowEntry> {
    const result: Record<string, LearnedModelWindowEntry> = {};
    for (const [k, v] of this.models.entries()) {
      result[k] = { ...v };
    }
    return result;
  }
}

/**
 * Create a freeze-safe ModelWindowStore instance.
 *
 * Cache state is held in a closure rather than as object properties, ensuring
 * that Object.freeze / deepFreeze(config) does not break subsequent memoization.
 */
export function createModelWindowStore(options?: ModelWindowStoreOptions): ModelWindowStore {
  let cachedData: ModelWindowStoreData | undefined;

  function load(): ModelWindowStoreData {
    if (cachedData === undefined) {
      cachedData = readModelWindowStore(options);
    }
    return cachedData;
  }

  return {
    get(model: string): number | undefined {
      if (!model) return undefined;
      return load().models[model]?.contextWindow;
    },

    getEntry(model: string): LearnedModelWindowEntry | undefined {
      if (!model) return undefined;
      const entry = load().models[model];
      return entry ? { ...entry } : undefined;
    },

    ratchet(model: string, ceiling: number): boolean {
      if (
        !model ||
        typeof ceiling !== 'number' ||
        !Number.isFinite(ceiling) ||
        ceiling < MIN_LEARNED_CONTEXT_WINDOW
      ) {
        return false;
      }
      const fresh = readModelWindowStore(options);
      if (fresh.version > MODEL_WINDOW_STORE_VERSION) {
        return false;
      }
      const normalizedCeiling = Math.floor(ceiling);
      const existingEntry = fresh.models[model];
      const targetCeiling = existingEntry
        ? Math.min(existingEntry.contextWindow, normalizedCeiling)
        : normalizedCeiling;

      if (existingEntry && existingEntry.contextWindow === targetCeiling) {
        // If the merged value equals what is already on disk, write nothing and return false.
        return false;
      }

      const now = options?.now ? options.now() : Date.now();
      const updated: ModelWindowStoreData = {
        version: fresh.version,
        models: {
          ...fresh.models,
          [model]: {
            contextWindow: targetCeiling,
            learnedAt: now,
          },
        },
      };
      const written = writeModelWindowStore(updated, options);
      if (written) {
        cachedData = updated;
        return true;
      }
      return false;
    },

    all(): Record<string, LearnedModelWindowEntry> {
      const models = load().models;
      const result: Record<string, LearnedModelWindowEntry> = {};
      for (const [k, v] of Object.entries(models)) {
        result[k] = { ...v };
      }
      return result;
    },
  };
}

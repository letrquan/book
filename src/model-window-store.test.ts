import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createModelWindowStore,
  defaultModelWindowStorePath,
  MemoryModelWindowStore,
  MODEL_WINDOW_STORE_VERSION,
  ratchetModelWindow,
  readModelWindowStore,
  writeModelWindowStore,
} from './model-window-store.js';

describe('model-window-store', () => {
  let tempHome: string;
  let tempWorkspace: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'book-home-test-'));
    tempWorkspace = mkdtempSync(join(tmpdir(), 'book-workspace-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
    try {
      rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  describe('path resolution and workspace isolation', () => {
    it('resolves under BOOK_HOME and never inside the workspace', () => {
      const explicitPath = defaultModelWindowStorePath(tempHome);
      expect(explicitPath).toBe(join(tempHome, 'model-windows.json'));
      expect(explicitPath).not.toContain(tempWorkspace);

      const previousEnv = process.env.BOOK_HOME;
      try {
        process.env.BOOK_HOME = tempHome;
        const envPath = defaultModelWindowStorePath();
        expect(envPath).toBe(join(tempHome, 'model-windows.json'));
      } finally {
        if (previousEnv === undefined) {
          delete process.env.BOOK_HOME;
        } else {
          process.env.BOOK_HOME = previousEnv;
        }
      }
    });

    it('ignores any model-windows.json located in the workspace', () => {
      // Even if a repository malicious or accidental check-in contains model-windows.json:
      const workspaceTamperPath = join(tempWorkspace, 'model-windows.json');
      const workspaceDotBookPath = join(tempWorkspace, '.book', 'model-windows.json');
      mkdirSync(join(tempWorkspace, '.book'), { recursive: true });

      writeFileSync(
        workspaceTamperPath,
        JSON.stringify({
          version: 1,
          models: { 'compromised/model': { contextWindow: 999_999, learnedAt: 1000 } },
        }),
      );
      writeFileSync(
        workspaceDotBookPath,
        JSON.stringify({
          version: 1,
          models: { 'compromised/model': { contextWindow: 888_888, learnedAt: 1000 } },
        }),
      );

      const previousEnv = process.env.BOOK_HOME;
      const previousCwd = process.cwd();
      try {
        process.env.BOOK_HOME = tempHome;
        process.chdir(tempWorkspace);

        const store = createModelWindowStore();
        expect(store.get('compromised/model')).toBeUndefined();
        expect(existsSync(join(tempHome, 'model-windows.json'))).toBe(false);
      } finally {
        process.chdir(previousCwd);
        if (previousEnv === undefined) {
          delete process.env.BOOK_HOME;
        } else {
          process.env.BOOK_HOME = previousEnv;
        }
      }
    });
  });

  describe('persistence and tolerance', () => {
    it('round-trips store data through atomic write and read', () => {
      const data = {
        version: MODEL_WINDOW_STORE_VERSION,
        models: {
          '9router/ag/gemini-3.8-flash-high': {
            contextWindow: 65_536,
            learnedAt: 1_700_000_000_000,
          },
          'openai/gpt-5': {
            contextWindow: 100_000,
            learnedAt: 1_700_000_100_000,
          },
        },
      };

      const writeSuccess = writeModelWindowStore(data, { home: tempHome });
      expect(writeSuccess).toBe(true);

      const storePath = defaultModelWindowStorePath(tempHome);
      expect(existsSync(storePath)).toBe(true);

      const readBack = readModelWindowStore({ home: tempHome });
      expect(readBack).toEqual(data);
    });

    it('tolerates a missing file without throwing', () => {
      const empty = readModelWindowStore({ home: tempHome });
      expect(empty).toEqual({ version: MODEL_WINDOW_STORE_VERSION, models: {} });
    });

    it('tolerates an empty file without throwing', () => {
      const filePath = defaultModelWindowStorePath(tempHome);
      writeFileSync(filePath, '');
      const empty = readModelWindowStore({ home: tempHome });
      expect(empty).toEqual({ version: MODEL_WINDOW_STORE_VERSION, models: {} });
    });

    it('tolerates a corrupt/malformed JSON file without throwing', () => {
      const filePath = defaultModelWindowStorePath(tempHome);
      writeFileSync(filePath, '{"version": 1, models: broken json...%#!');
      const empty = readModelWindowStore({ home: tempHome });
      expect(empty).toEqual({ version: MODEL_WINDOW_STORE_VERSION, models: {} });
    });

    it('tolerates schema mismatch without throwing', () => {
      const filePath = defaultModelWindowStorePath(tempHome);
      writeFileSync(filePath, JSON.stringify({ version: 'invalid', models: 'not-an-object' }));
      const empty = readModelWindowStore({ home: tempHome });
      expect(empty).toEqual({ version: MODEL_WINDOW_STORE_VERSION, models: {} });
    });

    it('survives a malformed entry without discarding valid entries', () => {
      const filePath = defaultModelWindowStorePath(tempHome);
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          models: {
            'valid/model': {
              contextWindow: 65_536,
              learnedAt: 1000,
            },
            'invalid/model': {
              contextWindow: '65536',
              learnedAt: 1000,
            },
          },
        }),
      );

      const store = readModelWindowStore({ home: tempHome });
      expect(store.models['valid/model']).toEqual({
        contextWindow: 65_536,
        learnedAt: 1000,
      });
      expect(store.models['invalid/model']).toBeUndefined();
    });

    it('treats a store with a future version as read-only and refuses ratchet', () => {
      const filePath = defaultModelWindowStorePath(tempHome);
      const originalContent =
        JSON.stringify(
          {
            version: 999,
            models: {
              'future/model': {
                contextWindow: 65_536,
                learnedAt: 1000,
              },
            },
          },
          null,
          2,
        ) + '\n';
      writeFileSync(filePath, originalContent, 'utf-8');

      const store = createModelWindowStore({ home: tempHome });
      expect(store.get('future/model')).toBe(65_536);

      const changed = store.ratchet('future/model', 32_000);
      expect(changed).toBe(false);

      const newModelChanged = store.ratchet('another/model', 32_000);
      expect(newModelChanged).toBe(false);

      const afterContent = readFileSync(filePath, 'utf-8');
      expect(afterContent).toBe(originalContent);
    });

    it('performs atomic replace without leaving temporary files behind', () => {
      const store = createModelWindowStore({ home: tempHome });
      const changed = store.ratchet('test-model', 50_000);
      expect(changed).toBe(true);

      const storePath = defaultModelWindowStorePath(tempHome);
      expect(existsSync(storePath)).toBe(true);
      const content = readFileSync(storePath, 'utf-8');
      expect(JSON.parse(content).models['test-model'].contextWindow).toBe(50_000);
    });
  });

  describe('ratchet monotonicity', () => {
    it('records initial ceiling when no entry exists', () => {
      const currentTime = 1000;
      const clock = () => currentTime;

      const changed = ratchetModelWindow('router/model-a', 128_000, {
        home: tempHome,
        now: clock,
      });
      expect(changed).toBe(true);

      const store = createModelWindowStore({ home: tempHome });
      expect(store.get('router/model-a')).toBe(128_000);
      expect(store.getEntry('router/model-a')).toEqual({
        contextWindow: 128_000,
        learnedAt: 1000,
      });
    });

    it('lowers ceiling when a smaller size is recorded', () => {
      let currentTime = 1000;
      const clock = () => currentTime;

      ratchetModelWindow('router/model-a', 128_000, { home: tempHome, now: clock });

      currentTime = 2000;
      const lowered = ratchetModelWindow('router/model-a', 64_000, {
        home: tempHome,
        now: clock,
      });
      expect(lowered).toBe(true);

      const store = createModelWindowStore({ home: tempHome });
      expect(store.get('router/model-a')).toBe(64_000);
      expect(store.getEntry('router/model-a')).toEqual({
        contextWindow: 64_000,
        learnedAt: 2000,
      });
    });

    it('refuses to raise ceiling when a larger size is recorded', () => {
      let currentTime = 1000;
      const clock = () => currentTime;

      ratchetModelWindow('router/model-a', 64_000, { home: tempHome, now: clock });

      currentTime = 2000;
      const raised = ratchetModelWindow('router/model-a', 100_000, {
        home: tempHome,
        now: clock,
      });
      expect(raised).toBe(false);

      const store = createModelWindowStore({ home: tempHome });
      expect(store.get('router/model-a')).toBe(64_000);
      // Timestamp remains from the lower recording
      expect(store.getEntry('router/model-a')?.learnedAt).toBe(1000);
    });

    it('is stable when an equal ceiling is recorded', () => {
      let currentTime = 1000;
      const clock = () => currentTime;

      ratchetModelWindow('router/model-a', 64_000, { home: tempHome, now: clock });

      currentTime = 2000;
      const equal = ratchetModelWindow('router/model-a', 64_000, {
        home: tempHome,
        now: clock,
      });
      expect(equal).toBe(false);

      const store = createModelWindowStore({ home: tempHome });
      expect(store.get('router/model-a')).toBe(64_000);
      expect(store.getEntry('router/model-a')?.learnedAt).toBe(1000);
    });

    it('tracks distinct models independently', () => {
      const store = createModelWindowStore({ home: tempHome });
      store.ratchet('router/model-a', 64_000);
      store.ratchet('router/model-b', 32_000);

      expect(store.get('router/model-a')).toBe(64_000);
      expect(store.get('router/model-b')).toBe(32_000);

      store.ratchet('router/model-a', 48_000);
      expect(store.get('router/model-a')).toBe(48_000);
      expect(store.get('router/model-b')).toBe(32_000);
    });

    it('rejects invalid or non-positive numbers gracefully', () => {
      const store = createModelWindowStore({ home: tempHome });
      expect(store.ratchet('test', 0)).toBe(false);
      expect(store.ratchet('test', -100)).toBe(false);
      expect(store.ratchet('test', NaN)).toBe(false);
      expect(store.ratchet('test', Infinity)).toBe(false);
      expect(store.get('test')).toBeUndefined();
    });

    it('caches parsed entries in memory and avoids disk reads on subsequent get() calls', () => {
      const store = createModelWindowStore({ home: tempHome });
      store.ratchet('router/cached-model', 75_000);
      expect(store.get('router/cached-model')).toBe(75_000);

      // Overwrite the underlying file on disk with empty models:
      // A non-caching store would read disk and return undefined.
      const filePath = defaultModelWindowStorePath(tempHome);
      writeFileSync(filePath, JSON.stringify({ version: 1, models: {} }), 'utf-8');

      // The store must return the in-memory cached value without reading disk
      expect(store.get('router/cached-model')).toBe(75_000);
      expect(store.getEntry('router/cached-model')?.contextWindow).toBe(75_000);
      expect(store.all()['router/cached-model']?.contextWindow).toBe(75_000);
    });

    it('refreshes the in-memory cache when ratchet() writes a new ceiling', () => {
      const store = createModelWindowStore({ home: tempHome });
      store.ratchet('router/cached-model', 75_000);
      expect(store.get('router/cached-model')).toBe(75_000);

      const lowered = store.ratchet('router/cached-model', 50_000);
      expect(lowered).toBe(true);
      expect(store.get('router/cached-model')).toBe(50_000);
    });

    it('does not lose entries written concurrently across instances', () => {
      const storeA = createModelWindowStore({ home: tempHome });
      const storeB = createModelWindowStore({ home: tempHome });

      const changedA = storeA.ratchet('model-x', 64_000);
      expect(changedA).toBe(true);

      const changedB = storeB.ratchet('model-y', 32_000);
      expect(changedB).toBe(true);

      const onDisk = readModelWindowStore({ home: tempHome });
      expect(onDisk.models['model-x']?.contextWindow).toBe(64_000);
      expect(onDisk.models['model-y']?.contextWindow).toBe(32_000);
    });

    it('preserves monotonicity across concurrent instances', () => {
      const initialStore = createModelWindowStore({ home: tempHome });
      initialStore.ratchet('model-x', 64_000);

      const storeA = createModelWindowStore({ home: tempHome });
      const storeB = createModelWindowStore({ home: tempHome });
      expect(storeA.get('model-x')).toBe(64_000);
      expect(storeB.get('model-x')).toBe(64_000);

      const loweredA = storeA.ratchet('model-x', 20_000);
      expect(loweredA).toBe(true);

      const raisedB = storeB.ratchet('model-x', 50_000);
      expect(raisedB).toBe(false);

      const onDisk = readModelWindowStore({ home: tempHome });
      expect(onDisk.models['model-x']?.contextWindow).toBe(20_000);
    });
  });

  describe('MemoryModelWindowStore', () => {
    it('provides identical ratchet monotonicity in memory', () => {
      let time = 500;
      const store = new MemoryModelWindowStore(undefined, () => time);

      expect(store.get('model-x')).toBeUndefined();
      expect(store.ratchet('model-x', 100_000)).toBe(true);
      expect(store.get('model-x')).toBe(100_000);

      time = 600;
      // Refuse raise
      expect(store.ratchet('model-x', 150_000)).toBe(false);
      expect(store.get('model-x')).toBe(100_000);

      time = 700;
      // Equal
      expect(store.ratchet('model-x', 100_000)).toBe(false);

      time = 800;
      // Lower
      expect(store.ratchet('model-x', 50_000)).toBe(true);
      expect(store.get('model-x')).toBe(50_000);
      expect(store.getEntry('model-x')?.learnedAt).toBe(800);
    });
  });

  describe('entry immutability and defensive copies', () => {
    it('returns copies from all() and getEntry() in MemoryModelWindowStore', () => {
      const store = new MemoryModelWindowStore({
        'model-x': { contextWindow: 64_000, learnedAt: 1000 },
      });

      const all = store.all();
      all['model-x'].contextWindow = 999_999;
      expect(store.get('model-x')).toBe(64_000);
      expect(store.all()['model-x'].contextWindow).toBe(64_000);

      const entry = store.getEntry('model-x');
      if (entry) entry.contextWindow = 888_888;
      expect(store.get('model-x')).toBe(64_000);
      expect(store.getEntry('model-x')?.contextWindow).toBe(64_000);
    });

    it('returns copies from all() and getEntry() in FileModelWindowStore', () => {
      const store = createModelWindowStore({ home: tempHome });
      store.ratchet('model-y', 50_000);

      const all = store.all();
      all['model-y'].contextWindow = 999_999;
      expect(store.get('model-y')).toBe(50_000);
      expect(store.all()['model-y'].contextWindow).toBe(50_000);

      const entry = store.getEntry('model-y');
      if (entry) entry.contextWindow = 888_888;
      expect(store.get('model-y')).toBe(50_000);
      expect(store.getEntry('model-y')?.contextWindow).toBe(50_000);
    });
  });
});

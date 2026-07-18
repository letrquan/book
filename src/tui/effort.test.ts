import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { persistSettingLocal } from './persist.js';
import {
  EFFORT_LEVELS,
  getAvailableEffortLevels,
  updateEffortLevel,
  type EffortLevel,
} from './effort.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('effort metadata', () => {
  it('uses all levels for unknown models', () => {
    expect(getAvailableEffortLevels({ model: 'unknown-model' })).toEqual(EFFORT_LEVELS);
  });

  it('disables effort when model metadata sets effort=false', () => {
    expect(
      getAvailableEffortLevels({ model: 'gateway/no-effort', modelInfo: { effort: false } }),
    ).toBeNull();
  });

  it('restricts choices to configured levels in canonical order', () => {
    expect(
      getAvailableEffortLevels({
        model: 'gateway/restricted',
        modelInfo: { effort: { levels: ['high', 'low'] } },
      }),
    ).toEqual(['low', 'high']);
  });
});

describe('updateEffortLevel', () => {
  it('persists before applying the live effort level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-effort-'));
    tempDirs.push(dir);
    const events: string[] = [];

    const result = updateEffortLevel(
      { model: 'unknown-model' },
      'xhigh',
      (level) => {
        events.push(`persist:${level}`);
        return persistSettingLocal(dir, 'effort', level);
      },
      (level) => events.push(`apply:${level}`),
    );

    expect(result).toEqual({ ok: true });
    expect(events).toEqual(['persist:xhigh', 'apply:xhigh']);
    expect(JSON.parse(readFileSync(join(dir, '.book', 'settings.local.json'), 'utf-8'))).toEqual({
      effort: 'xhigh',
    });
  });

  it('does not apply when persistence fails', () => {
    const apply = vi.fn();
    const result = updateEffortLevel(
      { model: 'unknown-model' },
      'high',
      () => ({ ok: false, error: 'read-only filesystem' }),
      apply,
    );

    expect(result).toEqual({
      ok: false,
      error: 'Failed to save effort level: read-only filesystem',
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects unsupported and restricted selections without persisting', () => {
    const persist = vi.fn(() => ({ ok: true }));
    const apply = vi.fn<(level: EffortLevel) => void>();

    expect(
      updateEffortLevel(
        { model: 'gateway/no-effort', modelInfo: { effort: false } },
        'high',
        persist,
        apply,
      ),
    ).toEqual({
      ok: false,
      error: 'Model "gateway/no-effort" does not support configurable effort.',
    });
    expect(
      updateEffortLevel(
        {
          model: 'restricted',
          modelSelection: 'gateway/restricted',
          modelInfo: { effort: { levels: ['low', 'medium'] } },
        },
        'max',
        persist,
        apply,
      ),
    ).toEqual({
      ok: false,
      error:
        'Effort level "max" is not supported by model "gateway/restricted". Available levels: low, medium.',
    });
    expect(persist).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});

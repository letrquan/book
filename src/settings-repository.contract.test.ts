import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SettingsRepository, readSettingsDocument } from './settings-repository.js';

function fixture(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'book-settings-repository-'));
  return {
    dir,
    path: join(dir, '.book', 'settings.local.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('SettingsRepository', () => {
  it('rejects invalid values without creating a settings file', () => {
    const item = fixture();
    try {
      const result = new SettingsRepository(item.path).set({ maxTurns: 0 });
      expect(result.ok).toBe(false);
      expect(existsSync(item.path)).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]?.issuePath).toBe('maxTurns');
    } finally {
      item.cleanup();
    }
  });

  it('preserves malformed JSON instead of replacing it', () => {
    const item = fixture();
    try {
      new SettingsRepository(item.path).set({ model: 'initial' });
      writeFileSync(item.path, '{broken', 'utf-8');
      const before = readFileSync(item.path, 'utf-8');

      expect(new SettingsRepository(item.path).set({ model: 'replacement' }).ok).toBe(false);
      expect(readFileSync(item.path, 'utf-8')).toBe(before);
      expect(readSettingsDocument(item.path).status).toBe('malformed');
    } finally {
      item.cleanup();
    }
  });

  it('rejects unknown top-level keys', () => {
    const item = fixture();
    try {
      const result = new SettingsRepository(item.path).set({ mystery: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]?.issuePath).toBe('mystery');
    } finally {
      item.cleanup();
    }
  });

  it('leaves the previous file intact when atomic replacement fails', () => {
    const item = fixture();
    try {
      new SettingsRepository(item.path).set({ model: 'before' });
      const before = readFileSync(item.path, 'utf-8');
      const repository = new SettingsRepository(item.path, {
        writeAtomic: () => {
          throw new Error('disk full');
        },
      });

      expect(repository.set({ model: 'after' }).ok).toBe(false);
      expect(readFileSync(item.path, 'utf-8')).toBe(before);
    } finally {
      item.cleanup();
    }
  });

  it('redacts secrets in successful mutation metadata', () => {
    const item = fixture();
    try {
      const result = new SettingsRepository(item.path).set({
        'provider.gateway.apiKey': 'top-secret',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(JSON.stringify(result.values)).not.toContain('top-secret');
    } finally {
      item.cleanup();
    }
  });
});

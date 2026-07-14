import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectMemoryCandidate,
  maybeCaptureMemoryCandidate,
  shouldRejectMemoryText,
} from './memory-autosave.js';
import { DEFAULT_SETTINGS } from './settings.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-memory-autosave-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('detectMemoryCandidate', () => {
  it('captures explicit remember statements as user candidates', () => {
    const candidate = detectMemoryCandidate({
      userMessage: 'Remember that I prefer concise final summaries.',
    });
    expect(candidate?.type).toBe('user');
    expect(candidate?.title).toContain('I prefer concise final summaries');
    expect(candidate?.tags).toContain('explicit');
  });

  it('classifies project conventions', () => {
    const candidate = detectMemoryCandidate({
      userMessage: 'Remember that in this repo we use pnpm.',
    });
    expect(candidate?.type).toBe('project');
  });

  it('captures useful confirmations only with previous assistant context', () => {
    expect(detectMemoryCandidate({ userMessage: 'that worked' })).toBeNull();
    const candidate = detectMemoryCandidate({
      userMessage: 'that worked',
      previousAssistant: 'Try using the portable temp dir.',
    });
    expect(candidate?.type).toBe('feedback');
    expect(candidate?.body).toContain('Prior assistant context');
  });

  it('ignores vague acknowledgements', () => {
    expect(detectMemoryCandidate({ userMessage: 'ok' })).toBeNull();
    expect(detectMemoryCandidate({ userMessage: 'thanks' })).toBeNull();
  });

  it('rejects secret-looking text', () => {
    expect(shouldRejectMemoryText('api_key=sk-abcdefghijklmnopqrstuvwxyz123456')).toContain(
      'secret',
    );
    expect(
      detectMemoryCandidate({
        userMessage: 'Remember that api_key=sk-abcdefghijklmnopqrstuvwxyz123456',
      }),
    ).toBeNull();
  });
});

describe('maybeCaptureMemoryCandidate', () => {
  it('does not write when auto-capture is disabled', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.memory.autoSave = false;
    const result = maybeCaptureMemoryCandidate({
      workspace,
      settings,
      userMessage: 'Remember that I prefer concise final summaries.',
    });
    expect(result.saved).toBe(false);
    expect(result.reason).toBe('auto-capture disabled');
  });
});

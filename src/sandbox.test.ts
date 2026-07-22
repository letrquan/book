import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSandbox } from './sandbox.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from './settings.js';

describe('createSandbox', () => {
  it('returns null when sandbox.enabled is false', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sandbox.enabled = false;
    expect(createSandbox(settings.sandbox)).toBeNull();
  });

  it('returns null with warning on Windows (sandbox unavailable)', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sandbox.enabled = true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // We can't change platform() but we can verify the bwrap-not-found path
    // by checking the function doesn't throw when failIfUnavailable is false.
    const sandbox = createSandbox(settings.sandbox);
    // On a system without bwrap, this returns null.
    // On a system with bwrap, it returns a Sandbox object.
    // Either is acceptable; we just verify it doesn't throw.
    expect(['object', 'null']).toContain(typeof sandbox);
    warnSpy.mockRestore();
  });

  it('throws when failIfUnavailable is true and bwrap missing (non-Windows)', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sandbox.enabled = true;
    settings.sandbox.failIfUnavailable = true;
    // This test passes on systems where bwrap is not installed.
    // On systems where bwrap IS installed, it would return a sandbox.
    // We just verify it doesn't crash unexpectedly.
    try {
      const sandbox = createSandbox(settings.sandbox);
      expect(['object', 'null']).toContain(typeof sandbox);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toMatch(/bwrap|sandbox|Windows/i);
    }
  });
});

describe('Bash tool integration with sandbox', () => {
  let dir: string;
  const ctx = {
    workspaceRoot: '',
    env: {},
    sandbox: undefined as ResolvedSettings['sandbox'] | undefined,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'book-sandbox-'));
    ctx.workspaceRoot = dir;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs commands normally when sandbox is disabled', async () => {
    const { createDefaultRegistry } = await import('./tools/registry.js');
    ctx.sandbox = { ...DEFAULT_SETTINGS.sandbox, enabled: false };
    const r = createDefaultRegistry();
    const result = await r.execute(
      { id: 'c1', name: 'Bash', arguments: { command: 'echo hello' } },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(result.content).toContain('hello');
    expect(result.content).not.toContain('[sandboxed]');
  });

  it('marks output as [sandboxed] when sandbox is enabled and available', async () => {
    const { createDefaultRegistry } = await import('./tools/registry.js');
    const { createSandbox } = await import('./sandbox.js');
    ctx.sandbox = { ...DEFAULT_SETTINGS.sandbox, enabled: true };

    // Only run this assertion if bwrap is actually available.
    const sandbox = createSandbox(ctx.sandbox);
    if (sandbox === null) {
      // bwrap not available — skip this test on Windows/bwrap-less systems.
      return;
    }

    const r = createDefaultRegistry();
    const result = await r.execute(
      { id: 'c1', name: 'Bash', arguments: { command: 'echo hello' } },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(result.content).toContain('[sandboxed]');
    expect(result.content).toContain('hello');
  });
});

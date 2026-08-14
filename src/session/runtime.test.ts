import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from './runtime.js';
import { DEFAULT_SETTINGS } from '../settings.js';

describe('SessionRuntime', () => {
  it('isolates mutable state between sessions', () => {
    const first = new SessionRuntime();
    const second = new SessionRuntime();

    first.tasks.push({
      id: '1',
      subject: 'first',
      description: '',
      activeForm: 'working',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      createdAt: 1,
      updatedAt: 1,
    });
    first.fileObservationLedger.set('workspace:file', {
      path: 'file',
      workspaceId: 'workspace',
      sha256: 'hash',
      byteSize: 1,
      operation: 'mention',
      sourceRef: 'user-1',
      timestamp: 1,
    });

    expect(second.tasks).toEqual([]);
    expect(second.fileObservationLedger.size).toBe(0);
    expect(second.traceId).not.toBe(first.traceId);
  });

  it('can share one tool execution scheduler with a managed child runtime', () => {
    const parent = new SessionRuntime();
    const child = new SessionRuntime({ toolExecutionScheduler: parent.toolExecutionScheduler });

    expect(child.toolExecutionScheduler).toBe(parent.toolExecutionScheduler);
  });

  it('disposes registered controllers, timers, children, and background shells once', () => {
    vi.useFakeTimers();
    try {
      const runtime = new SessionRuntime();
      const controller = runtime.trackAbortController(new AbortController());
      const timer = runtime.trackTimer(setTimeout(() => {}, 1000));
      const kill = vi.fn();
      const child = { killed: false, kill } as unknown as ChildProcess;
      runtime.trackChildProcess(child);
      runtime.backgroundShells.shells.set('shell-1', {
        id: 'shell-1',
        command: 'long-running',
        effectiveCommand: 'long-running',
        workdir: '.',
        process: child,
        status: 'running',
        output: '',
        readOffset: 0,
        truncatedBytes: 0,
        startedAt: 1,
        timer,
      });

      runtime.dispose('test');
      runtime.dispose('test-again');

      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('test');
      expect(kill).toHaveBeenCalledTimes(1);
      expect(runtime.backgroundShells.shells.size).toBe(0);
      expect(runtime.isDisposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('owns one normalized skill registry and invalidates context on reload', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-runtime-skills-'));
    try {
      const skillRoot = join(workspace, '.book', 'skills', 'review');
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(
        join(skillRoot, 'SKILL.md'),
        ['---', 'name: review', 'description: Review changes', '---', 'body'].join('\n'),
      );
      const runtime = new SessionRuntime();
      // A trailing "<sep>." must normalize to the same cache key as the bare workspace. The
      // separator has to be the platform's: on POSIX a literal "\" is an ordinary filename
      // character, so a hardcoded "\\." names a different, nonexistent directory.
      const first = runtime.skills(`${workspace}${sep}.`, DEFAULT_SETTINGS.skills);
      const second = runtime.skills(workspace, DEFAULT_SETTINGS.skills);
      expect(second).toBe(first);
      expect(second.list().some((skill) => skill.name === 'review')).toBe(true);

      const dirty = vi.fn();
      const unsubscribe = runtime.subscribeSkillChanges(workspace, dirty);
      expect(typeof unsubscribe).toBe('function');
      runtime.reloadSkills(workspace, DEFAULT_SETTINGS.skills);
      expect(runtime.skills(workspace, DEFAULT_SETTINGS.skills)).toBe(first);
      runtime.dispose();
      expect(runtime.isDisposed).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('defers watcher-driven reloads until the next safe consume boundary', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-runtime-skill-boundary-'));
    try {
      const skillRoot = join(workspace, '.book', 'skills', 'review');
      const entry = join(skillRoot, 'SKILL.md');
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(
        entry,
        ['---', 'name: review', 'description: First description', '---', 'body'].join('\n'),
      );
      const runtime = new SessionRuntime();
      const registry = runtime.skills(workspace, DEFAULT_SETTINGS.skills);
      let dirty = false;
      runtime.subscribeSkillChanges(workspace, () => {
        dirty = true;
      });

      writeFileSync(
        entry,
        ['---', 'name: review', 'description: Second description', '---', 'body'].join('\n'),
      );
      const started = Date.now();
      while (!dirty) {
        if (Date.now() - started > 2_000) throw new Error('Timed out waiting for skill watcher');
        await wait(20);
      }

      expect(registry.get('review')?.description).toBe('First description');
      const reloadsBeforeConsume = registry.events.filter(
        (event) => event.type === 'skill_reloaded',
      ).length;
      const refreshed = runtime.consumeSkillChanges(workspace, DEFAULT_SETTINGS.skills);
      expect(refreshed).toBe(registry);
      expect(refreshed.get('review')?.description).toBe('Second description');
      expect(registry.events.filter((event) => event.type === 'skill_reloaded').length).toBe(
        reloadsBeforeConsume + 1,
      );
      runtime.consumeSkillChanges(workspace, DEFAULT_SETTINGS.skills);
      expect(registry.events.filter((event) => event.type === 'skill_reloaded').length).toBe(
        reloadsBeforeConsume + 1,
      );
      runtime.dispose();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('stops skill watching when the global skill switch is disabled', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-runtime-skills-disabled-'));
    try {
      const runtime = new SessionRuntime();
      const enabledSettings = { ...DEFAULT_SETTINGS.skills, enabled: true };
      const disabledSettings = { ...DEFAULT_SETTINGS.skills, enabled: false };
      const dirty = vi.fn();
      runtime.subscribeSkillChanges(workspace, dirty, true);
      runtime.consumeSkillChanges(workspace, disabledSettings);

      mkdirSync(join(workspace, '.book', 'skills', 'new-skill'), { recursive: true });
      writeFileSync(
        join(workspace, '.book', 'skills', 'new-skill', 'SKILL.md'),
        ['---', 'name: new-skill', 'description: New skill', '---', 'body'].join('\n'),
      );
      await wait(250);

      expect(runtime.skillWatcherError).toBeUndefined();
      expect(dirty).not.toHaveBeenCalled();
      expect(
        runtime.consumeSkillChanges(workspace, enabledSettings).get('new-skill'),
      ).toBeDefined();
      runtime.dispose();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

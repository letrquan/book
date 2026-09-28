import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { SessionRuntime, toolNamesFromHistory } from './runtime.js';
import { toolFailure, toolSuccess } from '../tools/result.js';
import type { Message } from '../types/messages.js';
import { DEFAULT_SETTINGS } from '../settings.js';

// Skill discovery walks up to the nearest existing directory, so a runtime left on the real
// home directory watches the whole user profile. Pin discovery inside the temp workspace to
// keep watcher tests off unrelated filesystem traffic.
function hermeticRuntime(workspace: string): SessionRuntime {
  return new SessionRuntime({
    skillDiscoveryOptions: { homeDir: join(workspace, 'home'), projectRoot: workspace },
  });
}

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

  /**
   * A child whose tree teardown is already under way must not be killed directly first: on Windows
   * `taskkill /T` walks the tree from a root that has to still be alive, and the direct kill used
   * to land in the same tick as the abort that began the teardown, so the wrapper died first and
   * the tree was orphaned instead of ended (#314).
   */
  it('does not kill a child whose tree teardown is already under way', () => {
    vi.useFakeTimers();
    try {
      const runtime = new SessionRuntime();
      const kill = vi.fn();
      const child = { killed: false, kill, pid: undefined } as unknown as ChildProcess;
      runtime.trackChildProcess(child);
      runtime.trackTreeTermination(child);

      runtime.dispose('test');

      expect(kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills an ordinary child on dispose and forgets it once released', () => {
    const runtime = new SessionRuntime();
    const kill = vi.fn();
    const child = { killed: false, kill } as unknown as ChildProcess;
    runtime.trackChildProcess(child);
    runtime.releaseChildProcess(child);

    runtime.dispose('test');

    expect(kill).not.toHaveBeenCalled();
  });

  it('claims session shells by default, and only a child runtime gives them up', () => {
    // A Task subagent's and a managed agent's runtime is disposed when their run ends, so a
    // foreground `Bash` that reaches its deadline is killed there rather than adopted (#302).
    expect(new SessionRuntime().ownsSessionShells).toBe(true);
    expect(new SessionRuntime({ ownsSessionShells: false }).ownsSessionShells).toBe(false);
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
      const runtime = hermeticRuntime(workspace);
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
      const runtime = hermeticRuntime(workspace);
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
      const runtime = hermeticRuntime(workspace);
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

describe('toolNamesFromHistory', () => {
  it('does not count calls rejected for their arguments, including invalid JSON', () => {
    const messages: Message[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        includeInContext: true,
        timestamp: 1,
        toolCalls: [
          { id: 'ran', name: 'WebFetch', arguments: { url: 'https://example.com' } },
          { id: 'schema', name: 'WebSearch', arguments: { nonsense: true } },
          { id: 'json', name: 'Task', arguments: { __raw: '{"prompt":' } },
        ],
        toolResults: [
          toolSuccess('page', { toolCallId: 'ran' }),
          // The registry marks the rejections it makes itself; a `Read` that read the
          // file and then refused its own `offset` carries the same code unflagged.
          toolFailure('Invalid arguments for WebSearch', {
            toolCallId: 'schema',
            code: 'invalid_arguments',
            details: { preExecution: true },
          }),
          toolFailure('Invalid JSON arguments for Task', {
            toolCallId: 'json',
            code: 'invalid_json_arguments',
            details: { preExecution: true },
          }),
        ],
      },
    ];

    expect([...toolNamesFromHistory(messages)]).toEqual(['WebFetch']);
  });

  it('counts an unflagged invalid_arguments result as a call that ran', () => {
    // `Read {outline: true, offset}` reads the file and only then refuses the two
    // arguments, so the code alone cannot say whether the tool ran; the refusal the
    // registry makes itself says so in its details.
    const messages: Message[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        includeInContext: true,
        timestamp: 1,
        toolCalls: [{ id: 'outline', name: 'Read', arguments: { outline: true, offset: 2 } }],
        toolResults: [
          toolFailure('outline and offset cannot be combined', {
            toolCallId: 'outline',
            code: 'invalid_arguments',
          }),
        ],
      },
    ];

    expect([...toolNamesFromHistory(messages)]).toEqual(['Read']);
  });

  it('does not count a call refused or cancelled before it started, and does count one that had', () => {
    // A resume seeds `usedToolNames` from this history, and memory quarantine reads it.
    // A call that never started read nothing, so counting it as external would
    // quarantine a conversation for a tool that never touched anything.
    const messages: Message[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        includeInContext: true,
        timestamp: 1,
        toolCalls: [
          { id: 'unknown', name: 'WebFetch', arguments: {} },
          { id: 'aborted', name: 'WebSearch', arguments: {} },
          { id: 'started', name: 'Bash', arguments: {} },
        ],
        toolResults: [
          toolFailure('Unknown tool: WebFetch', {
            toolCallId: 'unknown',
            code: 'unknown_tool',
          }),
          toolFailure('CANCELLED: Agent execution was interrupted', {
            toolCallId: 'aborted',
            code: 'cancelled_before_start',
            status: 'cancelled',
          }),
          // A `cancelled` result from `executeWithTimeout` belongs to a tool that had
          // already started, so it does count.
          toolFailure('CANCELLED: Bash was cancelled', {
            toolCallId: 'started',
            code: 'cancelled',
            status: 'cancelled',
          }),
        ],
      },
    ];

    expect([...toolNamesFromHistory(messages)]).toEqual(['Bash']);
  });
});

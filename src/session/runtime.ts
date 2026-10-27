import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentTask, BackgroundShellStore } from '../types/runtime.js';
import type { Todo } from '../tools/todo.js';
import type { FileObservation, ToolDiscoveryState } from '../types/tools.js';
import { AgentContextCache } from '../agent/context.js';
import { ToolExecutionScheduler } from '../tools/execution-scheduler.js';
import { FileChangeTracker } from '../tools/file-changes.js';
import { RunAccounting } from './run-accounting.js';
import { ShellJobManager } from '../jobs/shell-manager.js';
import type { AgentRunAmbientSnapshot } from '../types/runs.js';
import { SkillRegistry } from '../skill-registry.js';
import type { SkillRegistrySnapshot } from '../skill-registry.js';
import type { ResolvedSettings, SkillSettings } from '../settings.js';
import { createSandbox, type Sandbox } from '../sandbox.js';
import { SkillWatcher } from '../skill-watcher.js';
import type { DiscoverSkillsOptions } from '../skills.js';
import type { ActiveGoal } from '../types/goal.js';

export interface SessionRuntimeOptions {
  tasks?: AgentTask[];
  todos?: Todo[];
  backgroundShells?: BackgroundShellStore;
  fileObservationLedger?: Map<string, FileObservation>;
  toolDiscoveryState?: ToolDiscoveryState;
  agentContextCache?: AgentContextCache;
  toolExecutionScheduler?: ToolExecutionScheduler;
  runAccounting?: RunAccounting;
  runAmbientSnapshots?: Map<string, AgentRunAmbientSnapshot>;
  traceId?: string;
  skillRegistry?: SkillRegistry;
  /** Skill root discovery options, shared by the registry and the watcher so they agree. */
  skillDiscoveryOptions?: DiscoverSkillsOptions;
  /**
   * Whether this runtime is the session's long-lived one. `false` marks a runtime that is disposed
   * when one run ends — a Task subagent's, a managed agent's — and so may not adopt a timed-out
   * command as a background shell it would then destroy. Defaults to `true`.
   */
  ownsSessionShells?: boolean;
  /**
   * The store instances of every agent manager this session has disposed. Hand on the outgoing
   * runtime's set to its replacement; see {@link SessionRuntime.disposedAgentInstanceIds}.
   */
  disposedAgentInstanceIds?: Set<string>;
}

/** Mutable resources owned by one logical agent session. */
export class SessionRuntime {
  readonly tasks: AgentTask[];
  /**
   * The session's todo list. A readonly *binding* over a mutable array, matching
   * `tasks` — the loop seeds `ToolContext.todos` from it per invocation and
   * TodoWrite mutates it in place, so the plan survives across invocations within
   * one process and can be rehydrated from a `plan` record after a restart.
   */
  readonly todos: Todo[];
  /**
   * Set by a host that resumed a session with prior work but no persisted plan.
   * Surfaced once in `<session-state>` so a dropped plan is a visible event.
   */
  planUnrestored = false;
  /**
   * The session's `/goal`, if one is set. Read by the root loop each time the agent
   * stops without calling a tool; mutated there and by the host's `/goal` command.
   * A runtime is replaced on `/clear`, which is what clears the goal with it.
   */
  activeGoal?: ActiveGoal;
  /**
   * The loaded memory snapshot whose `MEMORY.md` was last seeded into the observation ledger, so
   * the seed happens once per snapshot: a later turn must not claim the model has seen a file that
   * changed since. A reloaded snapshot (a new object) is seeded again, as a resumed session is.
   */
  memoryIndexSeededFor?: object;
  readonly backgroundShells: BackgroundShellStore;
  readonly fileObservationLedger: Map<string, FileObservation>;
  /**
   * The changes on disk this session's notices have reported, and the observed texts they diff
   * against (#620 4a). Lives beside the ledger it reads, and is replaced with it.
   */
  readonly fileChanges = new FileChangeTracker();
  readonly toolDiscoveryState: ToolDiscoveryState;
  readonly agentContextCache: AgentContextCache;
  readonly toolExecutionScheduler: ToolExecutionScheduler;
  readonly traceId: string;
  readonly runAccounting: RunAccounting;
  readonly runAmbientSnapshots: Map<string, AgentRunAmbientSnapshot>;
  readonly shellManager: ShellJobManager;
  private sandboxInstance?: { key: string; sandbox: Sandbox | null };
  private skillRegistry?: SkillRegistry;
  private readonly skillDiscoveryOptions: DiscoverSkillsOptions;
  private skillWatcher?: SkillWatcher;
  private skillWatcherWorkspace?: string;
  private skillCatalogDirty = false;
  private skillWatcherFailure?: string;
  private readonly skillChangeListeners = new Set<() => void>();
  /** Advisory memory of recent identical tool failures (registry circuit breaker). */
  readonly recentToolFailures = new Map<string, number>();
  /**
   * Unattended refusals already reported to the operator this session, keyed by tool and remedy,
   * so print mode names each once however many loop runs the session makes (#264).
   */
  readonly unattendedRefusalNotices = new Set<string>();
  /** Per-session tool call/failure counters keyed by canonical tool name. */
  readonly toolCallStats = new Map<string, { calls: number; failures: Record<string, number> }>();
  /**
   * Whether this runtime is the session's long-lived one, and so may hand a long-running command
   * to its shell manager as a background job it will still own afterwards.
   *
   * A Task subagent and a managed agent each build a runtime of their own and dispose it when their
   * run ends, and disposing a runtime ends every session shell it holds — so a command adopted there
   * would be killed at the end of the very run that told the model it was not killed. Those two
   * pass `ownsSessionShells: false` and a foreground `Bash` that reaches its deadline is killed
   * there, as it was before #302.
   */
  readonly ownsSessionShells: boolean;
  /**
   * Files this session's tool output was clipped into, as absolute paths.
   *
   * Owned by the session rather than by one `runAgentLoop` call, because a clip
   * notice ("Full output: <path>") is read by later prompts: a path the session
   * cannot Read is a path the model was told to go and look at and then could
   * not (#248).
   */
  readonly clippedOutputPaths = new Set<string>();

  agentManager?: import('../agents/manager.js').AgentManager;
  /**
   * The store instances of the agent managers this session has disposed, its earlier runtimes'
   * included: one set, handed from each runtime to the next by `AgentSession.replaceRuntime`.
   * Every manager built on this runtime gives it to its store, which adds its own instance when it
   * is disposed and reads each instance in it as gone, whatever its lease file says (#568). A lease
   * outlives its dispose when the unlink fails (a Windows scanner holding the file), and would read
   * as a live owner of the records that manager wrote for up to 15 s.
   */
  readonly disposedAgentInstanceIds: Set<string>;
  private readonly abortControllers = new Set<AbortController>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly childProcesses = new Set<ChildProcess>();
  /**
   * Children whose whole process tree is already being torn down, by the tool that started it.
   *
   * `dispose()` must not kill these directly: on Windows `taskkill /T` walks the tree from a root
   * that has to still be alive, and the direct kill landed in the same tick as the abort that
   * began the teardown, so the wrapper died first and the tree was orphaned instead of ended
   * (#314). The mark is taken synchronously by the abort listener, before the teardown is
   * awaited, which is why it beats the loop in `dispose()`.
   */
  private readonly terminatingChildren = new Set<ChildProcess>();
  private disposed = false;

  constructor(options: SessionRuntimeOptions = {}) {
    this.tasks = options.tasks ?? [];
    this.todos = options.todos ?? [];
    this.backgroundShells = options.backgroundShells ?? { nextId: 1, shells: new Map() };
    this.fileObservationLedger = options.fileObservationLedger ?? new Map();
    this.toolDiscoveryState = options.toolDiscoveryState ?? { clock: 0, loaded: new Map() };
    this.agentContextCache = options.agentContextCache ?? new AgentContextCache();
    this.toolExecutionScheduler = options.toolExecutionScheduler ?? new ToolExecutionScheduler();
    this.runAccounting = options.runAccounting ?? new RunAccounting();
    this.runAmbientSnapshots = options.runAmbientSnapshots ?? new Map();
    this.shellManager = new ShellJobManager(this.backgroundShells);
    this.traceId = options.traceId ?? crypto.randomUUID();
    this.skillRegistry = options.skillRegistry;
    this.skillDiscoveryOptions = options.skillDiscoveryOptions ?? {};
    this.ownsSessionShells = options.ownsSessionShells ?? true;
    this.disposedAgentInstanceIds = options.disposedAgentInstanceIds ?? new Set();
  }

  /**
   * The session's sandbox, built once per distinct settings object.
   *
   * Building it per Bash call would re-emit its startup diagnostics — the
   * unenforceable-domain-policy and skipped-path warnings — on every single
   * command, interleaved into the Ink render or the headless stderr stream.
   */
  sandbox(settings: ResolvedSettings['sandbox']): Sandbox | null {
    const key = JSON.stringify(settings);
    if (this.sandboxInstance?.key !== key) {
      this.sandboxInstance = { key, sandbox: createSandbox(settings) };
    }
    return this.sandboxInstance.sandbox;
  }

  skills(workspace: string, settings: SkillSettings): SkillRegistry {
    const normalizedWorkspace = resolve(workspace);
    if (!settings.enabled) this.stopSkillWatcher(normalizedWorkspace);
    if (!this.skillRegistry || this.skillRegistry.workspace !== normalizedWorkspace) {
      this.skillRegistry = new SkillRegistry(
        normalizedWorkspace,
        settings,
        this.skillDiscoveryOptions,
      );
    } else {
      this.skillRegistry.updateSettings(settings);
    }
    return this.skillRegistry;
  }

  reloadSkills(workspace: string, settings: SkillSettings, cause = 'manual'): SkillRegistry {
    const normalizedWorkspace = resolve(workspace);
    if (!settings.enabled) this.stopSkillWatcher(normalizedWorkspace);
    let registry: SkillRegistry;
    if (!this.skillRegistry || this.skillRegistry.workspace !== normalizedWorkspace) {
      registry = new SkillRegistry(normalizedWorkspace, settings, this.skillDiscoveryOptions);
      this.skillRegistry = registry;
    } else {
      registry = this.skillRegistry;
      if (!registry.updateSettings(settings)) registry.reload(cause);
    }
    this.skillCatalogDirty = false;
    this.skillWatcherFailure = undefined;
    this.agentContextCache.invalidateWorkspace(workspace);
    return registry;
  }

  consumeSkillChanges(workspace: string, settings: SkillSettings): SkillRegistry {
    if (!settings.enabled) {
      this.stopSkillWatcher(resolve(workspace));
      this.skillCatalogDirty = false;
      this.skillWatcherFailure = undefined;
      return this.skills(workspace, settings);
    }
    this.ensureSkillWatcher(workspace);
    return this.skillCatalogDirty
      ? this.reloadSkills(workspace, settings, 'watcher')
      : this.skills(workspace, settings);
  }

  subscribeSkillChanges(workspace: string, listener: () => void, enabled = true): () => void {
    if (!enabled) {
      this.stopSkillWatcher(resolve(workspace));
      return () => undefined;
    }
    this.ensureSkillWatcher(workspace);
    this.skillChangeListeners.add(listener);
    return () => this.skillChangeListeners.delete(listener);
  }

  get skillWatcherError(): string | undefined {
    return this.skillWatcherFailure;
  }

  inspectSkills(currentTurn = 0): SkillRegistrySnapshot | undefined {
    return this.skillRegistry?.inspect(currentTurn);
  }

  private ensureSkillWatcher(workspace: string): void {
    const normalizedWorkspace = resolve(workspace);
    if (this.skillWatcher && this.skillWatcherWorkspace === normalizedWorkspace) return;
    this.skillWatcher?.close();
    this.skillWatcherWorkspace = normalizedWorkspace;
    this.skillWatcher = new SkillWatcher(normalizedWorkspace, {
      ...this.skillDiscoveryOptions,
      onDirty: () => {
        this.skillCatalogDirty = true;
        this.skillWatcherFailure = undefined;
        for (const listener of this.skillChangeListeners) listener();
      },
      onError: (error) => {
        this.skillWatcherFailure = error.message;
        this.skillRegistry?.recordWatcherFailure(error.message);
        for (const listener of this.skillChangeListeners) listener();
      },
    });
    this.skillWatcher.start();
  }

  private stopSkillWatcher(workspace: string): void {
    const normalizedWorkspace = resolve(workspace);
    if (this.skillWatcherWorkspace !== normalizedWorkspace && !this.skillWatcher) return;
    this.skillWatcher?.close();
    this.skillWatcher = undefined;
    this.skillWatcherWorkspace = undefined;
    this.skillChangeListeners.clear();
  }

  trackAbortController(controller: AbortController): AbortController {
    if (this.disposed) controller.abort('session_runtime_disposed');
    else this.abortControllers.add(controller);
    return controller;
  }

  releaseAbortController(controller: AbortController): void {
    this.abortControllers.delete(controller);
  }

  trackTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
    if (this.disposed) clearTimeout(timer);
    else this.timers.add(timer);
    return timer;
  }

  releaseTimer(timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  trackChildProcess(child: ChildProcess): ChildProcess {
    if (this.disposed && !child.killed) child.kill();
    else this.childProcesses.add(child);
    return child;
  }

  /**
   * Record that this tool has begun ending a child's whole process tree.
   *
   * Taken synchronously at the moment the teardown starts — inside an abort listener, before the
   * teardown promise is awaited — so `dispose()` in the same tick can tell a tree already on its
   * way down from a child it has to kill itself.
   */
  trackTreeTermination(child: ChildProcess): void {
    this.terminatingChildren.add(child);
  }

  releaseChildProcess(child: ChildProcess): void {
    this.childProcesses.delete(child);
    this.terminatingChildren.delete(child);
  }

  recordRunAmbientSnapshot(
    runId: string,
    snapshot: AgentRunAmbientSnapshot,
  ): AgentRunAmbientSnapshot {
    const existing = this.runAmbientSnapshots.get(runId);
    if (existing) return existing;
    this.runAmbientSnapshots.set(runId, snapshot);
    return snapshot;
  }

  snapshotRunAmbient(runId: string): AgentRunAmbientSnapshot | undefined {
    return this.runAmbientSnapshots.get(runId);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Dispose every resource registered by this session exactly once. */
  dispose(reason = 'session_runtime_disposed'): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.abortControllers) controller.abort(reason);
    this.abortControllers.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const shellProcesses = new Set(
      Array.from(this.backgroundShells.shells.values())
        .map((shell) => shell.process)
        .filter((child): child is ChildProcess => Boolean(child)),
    );
    for (const child of this.childProcesses) {
      if (shellProcesses.has(child)) continue;
      // A child whose tree is already being torn down is not killed here. The teardown needs a
      // live root — `taskkill /T` on Windows, the group leader on POSIX — and killing the wrapper
      // first is what left whole trees running after Book exited (#314).
      if (this.terminatingChildren.has(child)) continue;
      if (!child.killed) child.kill();
    }
    this.shellManager.dispose();
    this.skillWatcher?.close();
    this.skillWatcher = undefined;
    this.skillRegistry?.dispose();
    this.skillRegistry = undefined;
    this.skillChangeListeners.clear();
    this.agentManager?.dispose();
    this.agentManager = undefined;
    this.childProcesses.clear();
  }
}

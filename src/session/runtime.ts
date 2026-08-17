import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentTask, BackgroundShellStore } from '../types/runtime.js';
import type { FileObservation, ToolDiscoveryState } from '../types/tools.js';
import { AgentContextCache } from '../agent/context.js';
import { ToolExecutionScheduler } from '../tools/execution-scheduler.js';
import { RunAccounting } from './run-accounting.js';
import { ShellJobManager } from '../jobs/shell-manager.js';
import type { AgentRunAmbientSnapshot } from '../types/runs.js';
import { SkillRegistry } from '../skill-registry.js';
import type { SkillRegistrySnapshot } from '../skill-registry.js';
import type { SkillSettings } from '../settings.js';
import { SkillWatcher } from '../skill-watcher.js';
import type { DiscoverSkillsOptions } from '../skills.js';
import { ZeroMemRuntime } from '../agent/zero-mem-runtime.js';

export interface SessionRuntimeOptions {
  tasks?: AgentTask[];
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
  zeroMemRuntime?: ZeroMemRuntime;
}

/** Mutable resources owned by one logical agent session. */
export class SessionRuntime {
  readonly tasks: AgentTask[];
  readonly backgroundShells: BackgroundShellStore;
  readonly fileObservationLedger: Map<string, FileObservation>;
  readonly toolDiscoveryState: ToolDiscoveryState;
  readonly agentContextCache: AgentContextCache;
  readonly toolExecutionScheduler: ToolExecutionScheduler;
  readonly traceId: string;
  readonly runAccounting: RunAccounting;
  readonly runAmbientSnapshots: Map<string, AgentRunAmbientSnapshot>;
  readonly shellManager: ShellJobManager;
  readonly zeroMemRuntime: ZeroMemRuntime;
  private skillRegistry?: SkillRegistry;
  private readonly skillDiscoveryOptions: DiscoverSkillsOptions;
  private skillWatcher?: SkillWatcher;
  private skillWatcherWorkspace?: string;
  private skillCatalogDirty = false;
  private skillWatcherFailure?: string;
  private readonly skillChangeListeners = new Set<() => void>();
  /** Advisory memory of recent identical tool failures (registry circuit breaker). */
  readonly recentToolFailures = new Map<string, number>();
  /** Per-session tool call/failure counters keyed by canonical tool name. */
  readonly toolCallStats = new Map<string, { calls: number; failures: Record<string, number> }>();
  agentManager?: import('../agents/manager.js').AgentManager;
  private readonly abortControllers = new Set<AbortController>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly childProcesses = new Set<ChildProcess>();
  private disposed = false;

  constructor(options: SessionRuntimeOptions = {}) {
    this.tasks = options.tasks ?? [];
    this.backgroundShells = options.backgroundShells ?? { nextId: 1, shells: new Map() };
    this.fileObservationLedger = options.fileObservationLedger ?? new Map();
    this.toolDiscoveryState = options.toolDiscoveryState ?? { clock: 0, loaded: new Map() };
    this.agentContextCache = options.agentContextCache ?? new AgentContextCache();
    this.toolExecutionScheduler = options.toolExecutionScheduler ?? new ToolExecutionScheduler();
    this.runAccounting = options.runAccounting ?? new RunAccounting();
    this.runAmbientSnapshots = options.runAmbientSnapshots ?? new Map();
    this.shellManager = new ShellJobManager(this.backgroundShells);
    this.zeroMemRuntime = options.zeroMemRuntime ?? new ZeroMemRuntime();
    this.traceId = options.traceId ?? crypto.randomUUID();
    this.skillRegistry = options.skillRegistry;
    this.skillDiscoveryOptions = options.skillDiscoveryOptions ?? {};
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

  releaseChildProcess(child: ChildProcess): void {
    this.childProcesses.delete(child);
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
    void this.zeroMemRuntime.dispose().catch(() => undefined);
    this.childProcesses.clear();
  }
}

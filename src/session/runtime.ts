import type { ChildProcess } from 'node:child_process';
import type { AgentTask, BackgroundShellStore } from '../types/runtime.js';
import type { FileObservation, ToolDiscoveryState } from '../types/tools.js';
import { AgentContextCache } from '../agent/context.js';
import { ToolExecutionScheduler } from '../tools/execution-scheduler.js';
import { RunAccounting } from './run-accounting.js';

export interface SessionRuntimeOptions {
  tasks?: AgentTask[];
  backgroundShells?: BackgroundShellStore;
  fileObservationLedger?: Map<string, FileObservation>;
  toolDiscoveryState?: ToolDiscoveryState;
  agentContextCache?: AgentContextCache;
  toolExecutionScheduler?: ToolExecutionScheduler;
  runAccounting?: RunAccounting;
  traceId?: string;
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
    this.traceId = options.traceId ?? crypto.randomUUID();
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
    const ownedChildren = new Set(this.childProcesses);
    for (const shell of this.backgroundShells.shells.values()) {
      if (shell.timer) clearTimeout(shell.timer);
      if (shell.retentionTimer) clearTimeout(shell.retentionTimer);
      if (shell.process) ownedChildren.add(shell.process);
    }
    for (const child of ownedChildren) {
      if (!child.killed) child.kill();
    }
    this.agentManager?.dispose();
    this.agentManager = undefined;
    this.childProcesses.clear();
    this.backgroundShells.shells.clear();
  }
}

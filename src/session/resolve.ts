import type {
  CompactBoundary,
  GoalRecordData,
  PlanRecordData,
  RewindTarget,
  SessionMeta,
  SessionStoreInterface,
} from '../types/sessions.js';
import type { Message, Usage } from '../types/messages.js';
import type { SessionDriver } from '../types/runtime.js';
import { normalizeWorkspace } from './store.js';
import { createDebugLogger } from '../debug-log.js';

const log = createDebugLogger('session:resolve');

export type SessionStartSource = 'startup' | 'resume' | 'clear';

export interface SessionBootstrap {
  sessionId: string;
  sessionName?: string;
  history: Message[];
  transcript?: Message[];
  contextHistory?: Message[];
  compactBoundaries?: CompactBoundary[];
  rewindTargets?: RewindTarget[];
  activeEventIds?: string[];
  /**
   * The newest persisted plan, when the resumed session recorded one. Absent on a
   * fresh session and on a resumed session that never wrote a plan — the hosts use
   * that distinction to tell "no plan yet" from "the plan did not survive".
   */
  plan?: PlanRecordData;
  /** The newest persisted `/goal` record, restored onto the runtime when it holds an unmet goal. */
  goal?: GoalRecordData;
  /** Token totals from earlier processes of this session; cost is re-derived. */
  carriedUsage?: Usage;
  carriedModels?: string[];
  source: SessionStartSource;
  persisted: boolean;
  created: boolean;
}

export interface ResolveSessionOptions {
  cwd: string;
  resume?: string;
  continue?: boolean;
  sessionId?: string;
  sessionName?: string;
  forkSession?: boolean;
  /** Recorded on a session this process creates, and made `agent` on one an agent resumes. */
  driver?: SessionDriver;
}

/**
 * Once another agent has driven a session, its later turns are that agent's too: a resume must
 * not read the session as the user's, so the mark never goes back to human.
 */
export function recordResumeDriver(
  store: Pick<SessionStoreInterface, 'patchMeta'>,
  sessionId: string,
  recorded: SessionDriver | undefined,
  driver: SessionDriver | undefined,
): void {
  if (driver === 'agent' && recorded !== 'agent') store.patchMeta(sessionId, { driver: 'agent' });
}

export function selectSession(
  store: SessionStoreInterface,
  selector: string,
  cwd?: string,
): SessionMeta {
  const exact = store.findByName(selector) ?? store.findById(selector);
  if (exact) return exact;

  const normalizedCwd = cwd ? normalizeWorkspace(cwd) : undefined;
  const candidates = store
    .list()
    .filter((meta) => (normalizedCwd ? meta.cwd === normalizedCwd : true))
    .filter((meta) => meta.id.startsWith(selector));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error(`Session selector is ambiguous: ${selector}`);
  throw new Error(`Session not found: ${selector}`);
}

export function persistHistory(
  store: SessionStoreInterface,
  sessionId: string,
  history: Message[],
): void {
  for (const message of history) {
    store.append(sessionId, {
      type: message.role,
      eventId: message.id,
      timestamp: message.timestamp,
      data:
        message.role === 'user'
          ? {
              id: message.id,
              content: message.content,
              reasoningContent: message.reasoningContent,
              providerMetadata: message.providerMetadata,
              contextContent: message.contextContent,
              kind: message.kind,
              includeInContext: message.includeInContext,
              agentNotifications: message.agentNotifications,
              fileObservations: message.fileObservations,
            }
          : {
              id: message.id,
              complete: true,
              content: message.content,
              reasoningContent: message.reasoningContent,
              providerMetadata: message.providerMetadata,
              kind: message.kind,
              includeInContext: message.includeInContext,
              toolCalls: message.toolCalls,
              toolResults: message.toolResults,
              fileObservations: message.fileObservations,
            },
    });
  }
}

/**
 * Exit cleanup for a launch that ended before its first prompt (#444): remove the session
 * this launch created if nothing was ever recorded in it. A host calls it once its own work
 * is over, after the SessionEnd hooks, so a record a hook wrote keeps the session.
 *
 * Only a session the launch created (`created`) is ever a candidate: a resumed or continued
 * one is the user's, empty or not. Whether it is untouched is read from the stored file by the
 * store, never from a flag in memory; a store without `removeUntouched` (an SDK caller's own)
 * keeps everything. Exit must not fail over housekeeping, so nothing is thrown: a file another
 * process holds, or any other failure, leaves the session where it is.
 */
export function discardUntouchedSession(
  store: SessionStoreInterface | undefined,
  launch: Pick<SessionBootstrap, 'sessionId' | 'created'>,
): boolean {
  if (!store || !launch.created) return false;
  try {
    return store.removeUntouched?.(launch.sessionId) ?? false;
  } catch (error) {
    log.warn('could not remove the untouched session', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * The exit cleanup of an interactive host (#507): the launch's own session (when it created it)
 * and every session `/new` or `/clear` created since, whether or not it is still current. Each
 * is judged on its own by `discardUntouchedSession`, so a session that got a prompt, a name, or
 * a record from a hook stays. Returns how many were removed.
 *
 * `createdSessionIds` holds only sessions a transition made (`clearSession` always makes a new
 * id), so none of them is the launch's own and none needs checking against it.
 */
export function discardUntouchedSessions(
  store: SessionStoreInterface | undefined,
  launch: Pick<SessionBootstrap, 'sessionId' | 'created'>,
  createdSessionIds: Iterable<string>,
): number {
  let removed = 0;
  if (discardUntouchedSession(store, launch)) removed++;
  for (const sessionId of createdSessionIds) {
    if (discardUntouchedSession(store, { sessionId, created: true })) removed++;
  }
  return removed;
}

export function resolveSessionBootstrap(
  store: SessionStoreInterface | undefined,
  options: ResolveSessionOptions,
): SessionBootstrap {
  if (!store) {
    if (options.resume || options.continue) {
      throw new Error('Session persistence is disabled; /resume and --continue are unavailable.');
    }
    return {
      sessionId: options.sessionId ?? crypto.randomUUID(),
      sessionName: options.sessionName,
      history: [],
      transcript: [],
      contextHistory: [],
      compactBoundaries: [],
      rewindTargets: [],
      activeEventIds: [],
      source: 'startup',
      persisted: false,
      created: true,
    };
  }

  let selected: SessionMeta | undefined;
  if (options.resume) {
    selected = selectSession(store, options.resume, options.cwd);
  } else if (options.continue) {
    selected = store.mostRecentInCwd(options.cwd);
  } else if (options.sessionId) {
    selected = store.findById(options.sessionId);
    if (!selected) {
      const sessionId = store.create({
        id: options.sessionId,
        cwd: options.cwd,
        name: options.sessionName,
        driver: options.driver,
      });
      return {
        sessionId,
        sessionName: options.sessionName,
        history: [],
        transcript: [],
        contextHistory: [],
        compactBoundaries: [],
        rewindTargets: [],
        activeEventIds: [],
        source: 'startup',
        persisted: true,
        created: true,
      };
    }
  } else if (options.sessionName) {
    selected = store.findByName(options.sessionName);
  }

  if (selected) {
    const loaded = store.load(selected.id);
    if (options.forkSession) {
      // A fork carries the source's turns, so an agent-driven source makes an agent-driven fork.
      const driver = loaded.meta.driver === 'agent' ? 'agent' : options.driver;
      const sessionId = store.fork
        ? store.fork(selected.id, { cwd: options.cwd, name: options.sessionName, driver })
        : store.create({ cwd: options.cwd, name: options.sessionName, driver });
      if (!store.fork) persistHistory(store, sessionId, loaded.transcript);
      return {
        sessionId,
        sessionName: options.sessionName,
        history: loaded.contextHistory,
        transcript: loaded.transcript,
        contextHistory: loaded.contextHistory,
        compactBoundaries: loaded.compactBoundaries,
        rewindTargets: loaded.rewindTargets,
        activeEventIds: loaded.activeEventIds,
        plan: loaded.plan,
        goal: loaded.goal,
        source: 'resume',
        persisted: true,
        created: true,
      };
    }
    store.touch(selected.id);
    recordResumeDriver(store, selected.id, loaded.meta.driver, options.driver);
    return {
      sessionId: selected.id,
      sessionName: loaded.meta.name,
      history: loaded.contextHistory,
      transcript: loaded.transcript,
      contextHistory: loaded.contextHistory,
      compactBoundaries: loaded.compactBoundaries,
      rewindTargets: loaded.rewindTargets,
      activeEventIds: loaded.activeEventIds,
      plan: loaded.plan,
      goal: loaded.goal,
      carriedUsage: loaded.carriedUsage,
      carriedModels: loaded.carriedModels,
      source: 'resume',
      persisted: true,
      created: false,
    };
  }

  const sessionId = store.create({
    cwd: options.cwd,
    name: options.sessionName,
    driver: options.driver,
  });
  return {
    sessionId,
    sessionName: options.sessionName,
    history: [],
    transcript: [],
    contextHistory: [],
    compactBoundaries: [],
    rewindTargets: [],
    activeEventIds: [],
    source: 'startup',
    persisted: true,
    created: true,
  };
}

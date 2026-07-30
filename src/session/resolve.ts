import type {
  CompactBoundary,
  RewindTarget,
  SessionMeta,
  SessionStoreInterface,
} from '../types/sessions.js';
import type { Message } from '../types/messages.js';
import { normalizeWorkspace } from './store.js';

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
      const sessionId = store.fork
        ? store.fork(selected.id, { cwd: options.cwd, name: options.sessionName })
        : store.create({ cwd: options.cwd, name: options.sessionName });
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
        source: 'resume',
        persisted: true,
        created: true,
      };
    }
    store.touch(selected.id);
    return {
      sessionId: selected.id,
      sessionName: loaded.meta.name,
      history: loaded.contextHistory,
      transcript: loaded.transcript,
      contextHistory: loaded.contextHistory,
      compactBoundaries: loaded.compactBoundaries,
      rewindTargets: loaded.rewindTargets,
      activeEventIds: loaded.activeEventIds,
      source: 'resume',
      persisted: true,
      created: false,
    };
  }

  const sessionId = store.create({ cwd: options.cwd, name: options.sessionName });
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

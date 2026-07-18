import type {
  CompactBoundary,
  Message,
  SessionMeta,
  SessionRecord,
  SessionStoreInterface,
} from '../types.js';
import { normalizeWorkspace } from './store.js';

export type SessionStartSource = 'startup' | 'resume' | 'clear';

export interface SessionBootstrap {
  sessionId: string;
  sessionName?: string;
  /** Compatibility alias for contextHistory. */
  history: Message[];
  /** Full transcript when supplied by the Phase 1 store; optional for legacy hosts. */
  transcript?: Message[];
  /** Active provider history when supplied by the Phase 1 store. */
  contextHistory?: Message[];
  compactBoundaries?: CompactBoundary[];
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
    const record: SessionRecord = {
      type: message.kind === 'local' ? 'local' : message.role,
      eventId: message.id,
      timestamp: message.timestamp,
      data:
        message.kind === 'local'
          ? {
              kind: 'local',
              role: message.role,
              content: message.content,
              includeInContext: false,
            }
          : message.role === 'user'
            ? {
                content: message.content,
                contextContent: message.contextContent,
                includeInContext: message.includeInContext,
                fileObservations: message.fileObservations,
              }
            : {
                complete: true,
                content: message.content,
                includeInContext: message.includeInContext,
                toolCalls: message.toolCalls,
                toolResults: message.toolResults,
                fileObservations: message.fileObservations,
              },
    };
    store.append(sessionId, record);
  }
}

function emptyBootstrap(
  sessionId: string,
  sessionName: string | undefined,
  persisted: boolean,
): SessionBootstrap {
  const contextHistory: Message[] = [];
  return {
    sessionId,
    sessionName,
    history: contextHistory,
    transcript: [],
    contextHistory,
    compactBoundaries: [],
    source: 'startup',
    persisted,
    created: true,
  };
}

export function resolveSessionBootstrap(
  store: SessionStoreInterface | undefined,
  options: ResolveSessionOptions,
): SessionBootstrap {
  if (!store) {
    if (options.resume || options.continue) {
      throw new Error('Session persistence is disabled; /resume and --continue are unavailable.');
    }
    return emptyBootstrap(crypto.randomUUID(), options.sessionName, false);
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
      return emptyBootstrap(sessionId, options.sessionName, true);
    }
  } else if (options.sessionName) {
    selected = store.findByName(options.sessionName);
  }

  if (selected) {
    const loaded = store.load(selected.id);
    if (options.forkSession) {
      const sessionId = store.create({ cwd: options.cwd, name: options.sessionName });
      store.copyEvents(selected.id, sessionId);
      const forked = store.load(sessionId);
      return {
        sessionId,
        sessionName: options.sessionName,
        history: forked.contextHistory,
        transcript: forked.transcript,
        contextHistory: forked.contextHistory,
        compactBoundaries: forked.compactBoundaries,
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
      source: 'resume',
      persisted: true,
      created: false,
    };
  }

  const sessionId = store.create({ cwd: options.cwd, name: options.sessionName });
  return emptyBootstrap(sessionId, options.sessionName, true);
}

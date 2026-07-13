import type { Message, SessionMeta, SessionStoreInterface } from '../types.js';
import { normalizeWorkspace } from './store.js';

export type SessionStartSource = 'startup' | 'resume' | 'clear';

export interface SessionBootstrap {
  sessionId: string;
  sessionName?: string;
  history: Message[];
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
      timestamp: message.timestamp,
      data:
        message.role === 'user'
          ? { content: message.content, contextContent: message.contextContent }
          : {
              complete: true,
              content: message.content,
              toolCalls: message.toolCalls,
              toolResults: message.toolResults,
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
      sessionId: crypto.randomUUID(),
      sessionName: options.sessionName,
      history: [],
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
      const sessionId = store.create({ cwd: options.cwd, name: options.sessionName });
      persistHistory(store, sessionId, loaded.history);
      return {
        sessionId,
        sessionName: options.sessionName,
        history: loaded.history,
        source: 'resume',
        persisted: true,
        created: true,
      };
    }
    store.touch(selected.id);
    return {
      sessionId: selected.id,
      sessionName: loaded.meta.name,
      history: loaded.history,
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
    source: 'startup',
    persisted: true,
    created: true,
  };
}

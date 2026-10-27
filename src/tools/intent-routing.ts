import type { Message } from '../types/messages.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolContext, ToolDiscoveryContext } from '../types/tools.js';
import type { PeerSessionListing, PeerSessionRow } from '../types/messaging.js';
import { createDebugLogger } from '../debug-log.js';
import { mentionNamesPath } from '../input/input-expansion.js';
import {
  findSessionMentions,
  type SessionMention,
  type SessionMentionSource,
} from '../input/session-mentions.js';
import { peerLabel, resolvePeerAddress } from '../messaging/addressing.js';
import { sanitizeEnvelopeName } from '../messaging/envelope.js';
import { parseRule } from '../permissions.js';
import { neutralizeTags } from '../prompt-tags.js';
import { refusalWithoutLookup, webUrlPolicyFromEnv } from './web-policy.js';

const log = createDebugLogger('tools:discovery');

/** A tool a router asks for, and why. The reason goes to the debug log, never to the model. */
export interface IntentRoute {
  tool: string;
  reason: string;
}

/** What a router reads. */
export interface IntentRoutingInput {
  /** The text to route, NFC-normalized. */
  text: string;
  /** The environment the turn's tools run with: the host's, under the run's own. */
  env: Record<string, string | undefined>;
}

export interface IntentRouter {
  /** Names the router in the debug log. */
  name: string;
  route(input: IntentRoutingInput): IntentRoute[];
  /**
   * Notes for the model about what the user typed (#620's `@session` mentions). The host renders
   * them in the turn's `<session-state>` block, never in the cached prefix.
   */
  notes?(input: IntentRoutingInput): string[];
}

/** URLs the user wrote, anywhere in their text: inside a code fence too, since they wrote them. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/**
 * A URL in the user's text activates `WebFetch`, when WebFetch would fetch it: the policy's own
 * checks that need no DNS lookup, under the turn's environment, so a plain-HTTP, local or private
 * address routes only where `BOOK_WEB_ALLOW_HTTP` or `BOOK_WEB_ALLOW_PRIVATE_NETWORK` lets it.
 */
export const urlRouter: IntentRouter = {
  name: 'url',
  route: ({ text, env }) => {
    const policy = webUrlPolicyFromEnv(env);
    const fetchable = [...text.matchAll(URL_PATTERN)].some(([raw]) => {
      try {
        return refusalWithoutLookup(new URL(raw), policy) === undefined;
      } catch {
        return false;
      }
    });
    return fetchable ? [{ tool: 'WebFetch', reason: 'a URL' }] : [];
  },
};

/**
 * Words and phrases that ask for a web search, matched as standalone words in any letter case (see
 * `searchIntentPattern`). A phrase's words may be separated by any whitespace.
 */
export const SEARCH_INTENT_PHRASES = [
  'search',
  'look up',
  'latest',
  'news',
  'tìm',
  'tin tức',
] as const;

/**
 * A pattern matching any of `phrases` as standalone words: whitespace, an opening quote or bracket,
 * or the start before; whitespace, closing punctuation, or the end after, and `.` or `:` only where
 * a sentence goes on. So a path, a package spec, a flag or an identifier never matches:
 * `tool-search.ts`, `react@latest`, `--latest`, `news-feed/`, `search_index`.
 */
export function searchIntentPattern(phrases: readonly string[]): RegExp {
  const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = phrases.map((phrase) => phrase.split(/\s+/).map(escape).join('\\s+'));
  return new RegExp(
    `(?<=^|[\\s([{"'“‘«])(?:${alternatives.join('|')})(?=$|[\\s)\\]}"'”’»,;!?…]|[.:](?:\\s|$))`,
    'iu',
  );
}

const SEARCH_INTENT_PATTERN = searchIntentPattern(SEARCH_INTENT_PHRASES);

/** Code the user quoted, fenced or inline: its words are code, not intent. */
const CODE_SPANS = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/** Search intent in the user's text, outside code, activates `WebSearch`. */
export const searchIntentRouter: IntentRouter = {
  name: 'search-intent',
  route: ({ text }) => {
    const phrase = SEARCH_INTENT_PATTERN.exec(text.replace(CODE_SPANS, ' '))?.[0];
    return phrase ? [{ tool: 'WebSearch', reason: `"${phrase.toLowerCase()}"` }] : [];
  },
};

export const DEFAULT_INTENT_ROUTERS: readonly IntentRouter[] = [urlRouter, searchIntentRouter];

const SESSION_SEND = 'SessionSend';

/** A session's address as a note prints it, every part of it another session wrote made safe. */
function noteLabel(row: Pick<PeerSessionRow, 'name' | 'ref'>): string {
  return peerLabel({ name: neutralizeTags(sanitizeEnvelopeName(row.name)), ref: row.ref });
}

/** The mention as the user typed it, rebuilt from the name it matched. */
function noteMention(row: Pick<PeerSessionRow, 'name'>, ref: string | undefined): string {
  const name = neutralizeTags(sanitizeEnvelopeName(row.name));
  return `@${/\s/.test(name) ? `"${name}"` : name}${ref === undefined ? '' : ` [${ref}]`}`;
}

/**
 * The note for one mention, worded after Claude Code's `peer_mention`, or none when the mention
 * names no live session. It is decided by `resolvePeerAddress`, so it says what `SessionSend` would
 * do with the same address: a session shared by name is answered with its candidates, and one
 * without an inbox is never offered as a recipient.
 */
function sessionMentionNote(mention: SessionMention, rows: PeerSessionRow[]): string | undefined {
  const resolved = resolvePeerAddress(
    rows,
    mention.ref === undefined ? mention.name : `${mention.name} [${mention.ref}]`,
  );
  if (resolved.ok) {
    const label = noteLabel(resolved.target);
    return `The user @-mentioned the Book session "${label}" (this machine) as ${noteMention(resolved.target, mention.ref)}. If their message asks you to tell or ask that session something, use ${SESSION_SEND} with to: "${label}". Do not message it unless the user's message actually asks you to.`;
  }
  const [first] = resolved.candidates;
  if (!first) return undefined;
  const as = noteMention(first, mention.ref);
  switch (resolved.problem) {
    case 'self':
      return `The user @-mentioned ${as}, which is this session's own name: that is this session, not another one, so there is nothing to send it.`;
    case 'ambiguous': {
      const labels = resolved.candidates.map((row) => `"${noteLabel(row)}"`).join(', ');
      return `The user @-mentioned ${as}, which names ${resolved.candidates.length} Book sessions on this machine: ${labels}. If their message asks you to tell or ask that session something, confirm with the user which one they mean, then use ${SESSION_SEND} with that name and ref. Do not guess between them.`;
    }
    case 'no_inbox':
      return `The user @-mentioned the Book session "${noteLabel(first)}" (this machine) as ${as}. It has messaging off, so ${SESSION_SEND} cannot reach it; if their message asks you to tell or ask that session something, tell the user so instead.`;
    default:
      return undefined;
  }
}

/**
 * The `@session` router (#620): a mention of a live session, in this pid domain, writes a note
 * naming `SessionSend` and the session's exact `name [ref]`, and activates nothing, since
 * `SessionSend` is core while messaging is on. `sessions` is the registry read as the turn starts;
 * a mention `namesPath` says names a file or directory stays a file mention.
 */
export function sessionMentionRouter(
  sessions: PeerSessionListing,
  namesPath: (path: string) => boolean,
): IntentRouter {
  const rows = [...(sessions.self ? [sessions.self] : []), ...sessions.peers];
  return {
    name: 'session-mention',
    route: () => [],
    notes: ({ text }) => [
      ...new Set(
        findSessionMentions(text, namesPath).flatMap(
          (mention) => sessionMentionNote(mention, rows) ?? [],
        ),
      ),
    ],
  };
}

/**
 * The routers for the turn being started: the default ones, and the `@session` router while the
 * inbox is running, `SessionSend` is usable this turn and what the user typed mentions something
 * that is not on disk. Only then is the registry read, once and without a sweep, so a turn without
 * such a mention costs nothing. A registry that cannot be read routes no mention.
 */
export async function turnIntentRouters(
  request: IntentRoutingRequest,
  discovery: Pick<ToolDiscoveryContext, 'whyInactive'>,
  sessions: SessionMentionSource | undefined,
): Promise<readonly IntentRouter[]> {
  const text = routableText(request);
  if (
    !text ||
    !sessions?.available() ||
    // In the surface's authorized set now (role, capability rules, mode, runtime), where a core
    // tool is active: not in plan mode, nor under an allowed-tools list that leaves it out.
    discovery.whyInactive?.(SESSION_SEND) !== 'activatable' ||
    deniedOutright(SESSION_SEND, request.config)
  ) {
    return DEFAULT_INTENT_ROUTERS;
  }
  const namesPath = (path: string) =>
    mentionNamesPath(request.context.workspaceRoot, path, request.context.additionalRoots);
  if (findSessionMentions(text, namesPath).length === 0) return DEFAULT_INTENT_ROUTERS;
  try {
    return [...DEFAULT_INTENT_ROUTERS, sessionMentionRouter(await sessions.list(), namesPath)];
  } catch (error) {
    log.debug('session mentions not routed', { error: String(error) });
    return DEFAULT_INTENT_ROUTERS;
  }
}

export interface IntentRoutingRequest {
  /** What the user typed for this turn (`runAgentLoop`'s `typedText`); absent when they typed nothing. */
  typedText?: string;
  /** The prompt a `UserPromptSubmit` hook rewrote this turn to, when one did. */
  rewrittenPrompt?: string;
  /** The kind of the turn's user message. */
  kind?: Message['kind'];
  isSubagent?: boolean;
  config: AgentConfig;
  context: ToolContext;
}

export interface IntentRoutingResult {
  /** Every tool a router asked for, with the router's name and its reason. */
  routes: Array<IntentRoute & { router: string }>;
  /** The tools the surface loaded: those it authorizes, that were not active and evict nothing. */
  activated: string[];
  /** The routers' notes for the model, each once, for the turn's `<session-state>` block. */
  notes: string[];
}

/** Whether a `permissions.deny` rule refuses every call to `tool` (`WebFetch`, `WebFetch(*)`). */
function deniedOutright(tool: string, config: AgentConfig): boolean {
  return (config.settings.permissions?.deny ?? []).some((rule) => {
    const parsed = parseRule(rule);
    return parsed.toolName === tool && (parsed.pattern === null || parsed.pattern === '*');
  });
}

/** What the user typed for the turn, NFC-normalized, when the turn is one routing reads at all. */
function routableText(request: IntentRoutingRequest): string | undefined {
  if (!request.config.settings.toolDiscovery.intentRouting || request.isSubagent) return undefined;
  // An allowlist, so a kind added later (a peer message) is not routed by default.
  if (request.kind !== undefined && request.kind !== 'conversation') return undefined;
  // Input methods and macOS can send `tìm` decomposed; the patterns are written composed.
  const text = request.typedText?.normalize('NFC');
  return text?.trim() ? text : undefined;
}

/**
 * Route the turn being started, once, before its first model call (#619): each router reads what
 * the user typed and names tools, which load through the surface's own activation path (reason
 * `route`) under the same authorization and ToolSearch gate as a search, never evicting a loaded
 * tool. A tool a deny rule refuses outright is not routed, and a hook's rewrite of the prompt can
 * drop a route or a note but never add one. Text the user did not type never routes: a
 * notification, a peer message, a command's body, an inlined file, a subagent's task. Routing
 * executes nothing and adds no system-prompt text, so the cached prefix and the deferred-tool list
 * are the same with it or without; a router's note (#620) is for the turn's `<session-state>`
 * block, which the caller renders.
 */
export function routeTurnIntent(
  request: IntentRoutingRequest,
  discovery: Pick<ToolDiscoveryContext, 'activate'>,
  routers: readonly IntentRouter[] = DEFAULT_INTENT_ROUTERS,
): IntentRoutingResult {
  const result: IntentRoutingResult = { routes: [], activated: [], notes: [] };
  const text = routableText(request);
  if (!text) return result;
  // WebFetch reads its policy from the same environment.
  const env = { ...process.env, ...request.context.env };
  const routesOf = (input: string) =>
    routers.flatMap((router) =>
      router.route({ text: input, env }).map((route) => ({ ...route, router: router.name })),
    );
  const notesOf = (input: string) =>
    new Set(routers.flatMap((router) => router.notes?.({ text: input, env }) ?? []));
  result.routes = routesOf(text);
  result.notes = [...notesOf(text)];
  if (request.rewrittenPrompt !== undefined) {
    const rewritten = request.rewrittenPrompt.normalize('NFC');
    const kept = new Set(routesOf(rewritten).map((r) => r.tool));
    result.routes = result.routes.filter((route) => kept.has(route.tool));
    const keptNotes = notesOf(rewritten);
    result.notes = result.notes.filter((note) => keptNotes.has(note));
  }
  const requested = [...new Set(result.routes.map((route) => route.tool))].filter(
    (tool) => !deniedOutright(tool, request.config),
  );
  if (requested.length > 0) result.activated = discovery.activate(requested, 'route');
  if (result.routes.length > 0 || result.notes.length > 0) {
    log.debug('intent routed', {
      routes: result.routes,
      activated: result.activated,
      notes: result.notes.length,
    });
  }
  return result;
}

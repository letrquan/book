import type { Message } from '../types/messages.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { ToolContext, ToolDiscoveryContext } from '../types/tools.js';
import type { PeerSessionListing, PeerSessionRow } from '../types/messaging.js';
import { createDebugLogger } from '../debug-log.js';
import { mentionNamesPath } from '../input/input-expansion.js';
import {
  addressNeedsRef,
  findSessionMentions,
  listingRows,
  mentionAddress,
  sessionMentionKey,
  type SessionMention,
  type SessionMentionSource,
} from '../input/session-mentions.js';
import { peerLabel } from '../messaging/addressing.js';
import { evaluatePermission, parseRule } from '../permissions.js';
import { ruleRefusal } from './session-send.js';
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

/** What a mention reaches, as the note words it. */
type MentionOutcome =
  | {
      kind: 'send';
      target: PeerSessionRow & { socketPath: string };
      withRef: boolean;
      namesakes: number;
    }
  | { kind: 'ambiguous'; candidates: PeerSessionRow[] }
  | { kind: 'self' }
  | { kind: 'no_inbox'; target: PeerSessionRow };

/**
 * The session a mention reaches among `rows`, this session's own included. Only a session with an
 * inbox can be sent to, so only those make a name ambiguous: one reachable session of a shared
 * name is addressed by its ref, and the others are only counted.
 */
function resolveMention(
  mention: SessionMention,
  rows: readonly PeerSessionRow[],
): MentionOutcome | undefined {
  const named = rows.filter(
    (row) => row.name === mention.name && (mention.ref === undefined || row.ref === mention.ref),
  );
  const others = named.filter((row) => !row.self);
  if (others.length === 0) return named.length > 0 ? { kind: 'self' } : undefined;
  const reachable = others.filter(
    (row): row is PeerSessionRow & { socketPath: string } => row.socketPath !== undefined,
  );
  if (reachable.length === 0) return { kind: 'no_inbox', target: others[0] };
  if (reachable.length > 1) return { kind: 'ambiguous', candidates: reachable };
  const [target] = reachable;
  return {
    kind: 'send',
    target,
    withRef: addressNeedsRef(rows, target),
    namesakes: others.length - 1,
  };
}

/**
 * Whether this turn's permission settings refuse a `SessionSend` to `target` outright: a deny rule
 * on any spelling that reaches it (`ruleRefusal`'s check, plus the address itself), or `dontAsk`,
 * which refuses a call no allow rule admits.
 */
function sendRefused(
  request: IntentRoutingRequest,
  target: PeerSessionRow & { socketPath: string },
  to: string,
): boolean {
  const settings = request.config.settings;
  const verdict = evaluatePermission(SESSION_SEND, { to, message: '' }, settings);
  if (verdict === 'deny') return true;
  const mode = request.context.currentMode;
  if (mode === 'dontAsk' && verdict !== 'allow') return true;
  const refusal = ruleRefusal({ agentConfig: request.config, currentMode: mode }, to, '', target);
  return refusal?.structuredError?.code === 'permission_denied';
}

/** One note per session, keyed by what the mention reaches: two spellings of one session note once. */
function outcomeKey(outcome: MentionOutcome, mention: SessionMention): string {
  switch (outcome.kind) {
    case 'send':
      return `send\0${outcome.target.socketPath}`;
    case 'no_inbox':
      return `no_inbox\0${outcome.target.sessionId}`;
    case 'ambiguous':
      return `ambiguous\0${mention.name}`;
    case 'self':
      return 'self';
  }
}

/**
 * The note for one mention, worded after Claude Code's `peer_mention`. Every name in it is a row's,
 * which `peerSessionRow` sanitized when it read the record (`sanitizeEnvelopeName` strips the
 * characters a tag needs), or the user's own spelling of one.
 */
function sessionMentionNote(
  outcome: MentionOutcome,
  mention: SessionMention,
  refused: (target: PeerSessionRow & { socketPath: string }, to: string) => boolean,
): string {
  const as = `@${mentionAddress(mention, true)}`;
  switch (outcome.kind) {
    case 'send': {
      const label = peerLabel(outcome.target);
      const to = outcome.withRef ? label : outcome.target.name;
      const namesakes =
        outcome.namesakes > 0
          ? ' Another live session of that name has messaging off, so this is the one a message reaches.'
          : '';
      if (refused(outcome.target, to)) {
        return `The user @-mentioned the Book session "${label}" (this machine) as ${as}. The user's permission settings refuse ${SESSION_SEND} to it, so do not message it; if their message asks you to tell or ask that session something, tell them their settings block it.`;
      }
      return `The user @-mentioned the Book session "${label}" (this machine) as ${as}.${namesakes} If their message asks you to tell or ask that session something, use ${SESSION_SEND} with to: "${to}". Do not message it unless the user's message actually asks you to.`;
    }
    case 'ambiguous': {
      const labels = outcome.candidates.map((row) => `"${peerLabel(row)}"`).join(', ');
      return `The user @-mentioned ${as}, which names ${outcome.candidates.length} Book sessions on this machine: ${labels}. If their message asks you to tell or ask that session something, confirm with the user which one they mean, then use ${SESSION_SEND} with that name and ref. Do not guess between them.`;
    }
    case 'self':
      return `The user @-mentioned ${as}, which is this session's own name: that is this session, not another one, so there is nothing to send it.`;
    case 'no_inbox':
      return `The user @-mentioned the Book session "${outcome.target.name}" (this machine) as ${as}. It has messaging off, so ${SESSION_SEND} cannot reach it; if their message asks you to tell or ask that session something, tell the user so instead.`;
  }
}

/**
 * The `@session` router (#620): a mention of a live session, in this pid domain, writes a note
 * naming `SessionSend` and the session's address, and activates nothing, since `SessionSend` is
 * core while messaging is on. `mentions` are the typed mentions `turnIntentRouters` matched against
 * the registry and the disk, once; a text is read only for which of them it still holds, so a
 * hook's rewrite costs no second look at either.
 */
export function sessionMentionRouter(
  sessions: PeerSessionListing,
  mentions: readonly SessionMention[],
  refused: (target: PeerSessionRow & { socketPath: string }, to: string) => boolean = () => false,
): IntentRouter {
  const rows = listingRows(sessions);
  return {
    name: 'session-mention',
    route: () => [],
    notes: ({ text }) => {
      const written = new Set(findSessionMentions(text).map(sessionMentionKey));
      const notes = new Map<string, string>();
      for (const mention of mentions) {
        if (!written.has(sessionMentionKey(mention))) continue;
        const outcome = resolveMention(mention, rows);
        if (!outcome) continue;
        const key = outcomeKey(outcome, mention);
        if (!notes.has(key)) notes.set(key, sessionMentionNote(outcome, mention, refused));
      }
      return [...notes.values()];
    },
  };
}

/**
 * Whether `@` completion offers sessions (#620), as far as the host can tell before a turn: the
 * mode is not plan, which hides `SessionSend`, and no rule denies every `SessionSend`. The inbox's
 * own state is the caller's to check.
 */
export function sessionMentionsOffered(mode: PermissionMode, config: AgentConfig): boolean {
  return mode !== 'plan' && !deniedOutright(SESSION_SEND, config);
}

/** Whether a mention of a session can be had at all: the name and ref of a row. */
function namesListedSession(mention: SessionMention, rows: readonly PeerSessionRow[]): boolean {
  return rows.some(
    (row) => row.name === mention.name && (mention.ref === undefined || row.ref === mention.ref),
  );
}

export interface TurnIntentRouterOptions {
  /** The turn's abort signal: a registry read waits no longer than the turn does. */
  signal?: AbortSignal;
  /** Whether a mention's path names a file or directory; `mentionNamesPath` by default. */
  namesPath?: (path: string) => Promise<boolean>;
}

/**
 * The routers for the turn being started: the default ones, and the `@session` router while the
 * inbox is running, `SessionSend` is usable this turn and what the user typed mentions a session
 * the snapshot knows. A token that names no known session (`@types/node`, `@Override`) costs no
 * read at all. Only for one that does is the snapshot refreshed, when it is older than a few
 * seconds and no longer than the turn waits, and are the remaining tokens checked against the disk,
 * once: a file or directory of that name keeps its mention.
 */
export async function turnIntentRouters(
  request: IntentRoutingRequest,
  discovery: Pick<ToolDiscoveryContext, 'whyInactive'>,
  sessions: SessionMentionSource | undefined,
  options: TurnIntentRouterOptions = {},
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
  const cached = sessions.peek();
  const typed = findSessionMentions(text);
  if (!cached || !typed.some((mention) => namesListedSession(mention, listingRows(cached)))) {
    return DEFAULT_INTENT_ROUTERS;
  }
  const listing = (await sessions.fresh(options.signal)) ?? cached;
  const rows = listingRows(listing);
  const namesPath =
    options.namesPath ??
    ((path: string) =>
      mentionNamesPath(request.context.workspaceRoot, path, request.context.additionalRoots));
  const listed = typed.filter((mention) => namesListedSession(mention, rows));
  const onDisk = await Promise.all(listed.map((mention) => namesPath(mention.path)));
  const mentions = listed.filter((_, index) => !onDisk[index]);
  if (mentions.length === 0) return DEFAULT_INTENT_ROUTERS;
  return [
    ...DEFAULT_INTENT_ROUTERS,
    sessionMentionRouter(listing, mentions, (target, to) => sendRefused(request, target, to)),
  ];
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

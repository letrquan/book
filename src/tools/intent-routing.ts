import type { Message } from '../types/messages.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolContext, ToolDiscoveryContext } from '../types/tools.js';
import { createDebugLogger } from '../debug-log.js';

const log = createDebugLogger('tools:discovery');

/** A tool a router asks for, and why. The reason goes to the debug log, never to the model. */
export interface IntentRoute {
  tool: string;
  reason: string;
}

/** What one router makes of a turn. */
export interface IntentRouterOutput {
  /** Tools to activate before the turn's first model call. */
  tools?: IntentRoute[];
  /**
   * A meta note for the turn. No router here writes one; the `@session` router (#620) will, and
   * its host decides where the note goes. The seam only collects notes and never adds prompt text.
   */
  note?: string;
}

/** What a router reads. */
export interface IntentRoutingInput {
  /** What the user typed for the turn being started, NFC-normalized. */
  text: string;
  config: AgentConfig;
  context: ToolContext;
}

export interface IntentRouter {
  /** Names the router in the debug log. */
  name: string;
  route(input: IntentRoutingInput): IntentRouterOutput | undefined;
}

/** A URL the user wrote, anywhere in their text: inside a code fence too, since they wrote it. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/i;

/** A URL in the user's text activates `WebFetch`. */
export const urlRouter: IntentRouter = {
  name: 'url',
  route: ({ text }) =>
    URL_PATTERN.test(text) ? { tools: [{ tool: 'WebFetch', reason: 'a URL' }] } : undefined,
};

/**
 * Words and phrases that ask for a web search, matched as whole words in any letter case: `search`
 * does not match `research` or `searching`. A phrase's words may be separated by any whitespace.
 */
export const SEARCH_INTENT_PHRASES = [
  'search',
  'look up',
  'latest',
  'news',
  'tìm',
  'tin tức',
] as const;

// `\b` knows only ASCII word characters, so a letter or digit of any script bounds a word here:
// without that, `tìm` would match inside a longer Vietnamese word.
const SEARCH_INTENT_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_])(?:${SEARCH_INTENT_PHRASES.map((phrase) => phrase.split(' ').join('\\s+')).join('|')})(?![\\p{L}\\p{M}\\p{N}_])`,
  'iu',
);

/** Search intent in the user's text activates `WebSearch`. */
export const searchIntentRouter: IntentRouter = {
  name: 'search-intent',
  route: ({ text }) => {
    const phrase = SEARCH_INTENT_PATTERN.exec(text)?.[0];
    return phrase
      ? { tools: [{ tool: 'WebSearch', reason: `"${phrase.toLowerCase()}"` }] }
      : undefined;
  },
};

export const DEFAULT_INTENT_ROUTERS: readonly IntentRouter[] = [urlRouter, searchIntentRouter];

export interface IntentRoutingRequest {
  /** What the user typed for this turn (`runAgentLoop`'s `typedText`); absent when they typed nothing. */
  typedText?: string;
  /** The kind of the turn's user message. */
  kind?: Message['kind'];
  isSubagent?: boolean;
  config: AgentConfig;
  context: ToolContext;
}

export interface IntentRoutingResult {
  /** Every tool a router asked for, with the router's name and its reason. */
  routes: Array<IntentRoute & { router: string }>;
  /** The tools the surface loaded: those it authorizes, that fit its budgets and were not active. */
  activated: string[];
  notes: string[];
}

/**
 * Route the turn being started, once, before its first model call (#619): each router reads what
 * the user typed and names tools, which load through the surface's own activation path (reason
 * `route`) under the same authorization, budgets and ToolSearch gate as a search. Text the user
 * did not type never routes: a notification, a peer message, a command's body, an inlined file, a
 * subagent's task. Routing executes nothing and adds no prompt text, so the cached prefix and the
 * deferred-tool list are the same with it or without it.
 */
export function routeTurnIntent(
  request: IntentRoutingRequest,
  discovery: Pick<ToolDiscoveryContext, 'activate'>,
  routers: readonly IntentRouter[] = DEFAULT_INTENT_ROUTERS,
): IntentRoutingResult {
  const result: IntentRoutingResult = { routes: [], activated: [], notes: [] };
  if (!request.config.settings.toolDiscovery.intentRouting || request.isSubagent) return result;
  // An allowlist, so a kind added later (a peer message) is not routed by default.
  if (request.kind !== undefined && request.kind !== 'conversation') return result;
  // Input methods and macOS can send `tìm` decomposed; the patterns are written composed.
  const text = request.typedText?.normalize('NFC');
  if (!text?.trim()) return result;
  const input: IntentRoutingInput = { text, config: request.config, context: request.context };
  for (const router of routers) {
    const output = router.route(input);
    for (const route of output?.tools ?? []) result.routes.push({ ...route, router: router.name });
    if (output?.note) result.notes.push(output.note);
  }
  const requested = [...new Set(result.routes.map((route) => route.tool))];
  if (requested.length === 0) return result;
  result.activated = discovery.activate(requested, 'route');
  log.debug('intent routed', { routes: result.routes, activated: result.activated });
  return result;
}

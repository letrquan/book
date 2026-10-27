import type { Message } from '../types/messages.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolContext, ToolDiscoveryContext } from '../types/tools.js';
import { createDebugLogger } from '../debug-log.js';
import { parseRule } from '../permissions.js';
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
}

/** Whether a `permissions.deny` rule refuses every call to `tool` (`WebFetch`, `WebFetch(*)`). */
function deniedOutright(tool: string, config: AgentConfig): boolean {
  return (config.settings.permissions?.deny ?? []).some((rule) => {
    const parsed = parseRule(rule);
    return parsed.toolName === tool && (parsed.pattern === null || parsed.pattern === '*');
  });
}

/**
 * Route the turn being started, once, before its first model call (#619): each router reads what
 * the user typed and names tools, which load through the surface's own activation path (reason
 * `route`) under the same authorization and ToolSearch gate as a search, never evicting a loaded
 * tool. A tool a deny rule refuses outright is not routed, and a hook's rewrite of the prompt can
 * drop a route but never add one. Text the user did not type never routes: a notification, a peer
 * message, a command's body, an inlined file, a subagent's task. Routing executes nothing and adds
 * no prompt text, so the cached prefix and the deferred-tool list are the same with it or without.
 */
export function routeTurnIntent(
  request: IntentRoutingRequest,
  discovery: Pick<ToolDiscoveryContext, 'activate'>,
  routers: readonly IntentRouter[] = DEFAULT_INTENT_ROUTERS,
): IntentRoutingResult {
  const result: IntentRoutingResult = { routes: [], activated: [] };
  if (!request.config.settings.toolDiscovery.intentRouting || request.isSubagent) return result;
  // An allowlist, so a kind added later (a peer message) is not routed by default.
  if (request.kind !== undefined && request.kind !== 'conversation') return result;
  // Input methods and macOS can send `tìm` decomposed; the patterns are written composed.
  const text = request.typedText?.normalize('NFC');
  if (!text?.trim()) return result;
  // WebFetch reads its policy from the same environment.
  const env = { ...process.env, ...request.context.env };
  const routesOf = (input: string) =>
    routers.flatMap((router) =>
      router.route({ text: input, env }).map((route) => ({ ...route, router: router.name })),
    );
  result.routes = routesOf(text);
  if (request.rewrittenPrompt !== undefined) {
    const kept = new Set(routesOf(request.rewrittenPrompt.normalize('NFC')).map((r) => r.tool));
    result.routes = result.routes.filter((route) => kept.has(route.tool));
  }
  const requested = [...new Set(result.routes.map((route) => route.tool))].filter(
    (tool) => !deniedOutright(tool, request.config),
  );
  if (requested.length > 0) result.activated = discovery.activate(requested, 'route');
  if (result.routes.length > 0) {
    log.debug('intent routed', { routes: result.routes, activated: result.activated });
  }
  return result;
}

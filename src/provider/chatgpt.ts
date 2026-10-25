/**
 * The experimental `chatgpt` provider: Responses API requests billed to the user's ChatGPT plan
 * through Sign in with ChatGPT (`src/auth/chatgpt-oauth.ts`).
 *
 * The access token is read for each request and goes only into that request's copy of the
 * config. The session's `AgentConfig.apiKey` stays empty, so the token can never be inherited by
 * another provider or a bare model id on the same endpoint, and no API key ever reaches the plan
 * route. No sign-in means a failed request naming `book auth login`; nothing here opens a
 * browser, so print mode and the SDK behave like the TUI.
 */

import type { AgentConfig } from '../types/runtime.js';
import type {
  ProviderMessage,
  ProviderStreamEvent,
  ProviderStreamOptions,
} from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';
import {
  CHATGPT_LOGIN_COMMAND,
  CHATGPT_USAGE_URL,
  ChatGptSignInRequiredError,
  chatGptAccessToken,
  chatGptEndpoints,
} from '../auth/chatgpt-oauth.js';
import { responsesStream, type ResponsesRoute } from './openai-responses.js';

/** What the plan route needs on top of the plain Responses API. */
export const CHATGPT_ROUTE: ResponsesRoute = { omitMaxOutputTokens: true, toolNamespace: 'book' };

/** OpenAI's wording for a plan limit, with the place the user manages it. */
export const CHATGPT_USAGE_LIMIT_MESSAGE =
  "Usage limit reached. Review your plan or this app's limit in ChatGPT settings: " +
  CHATGPT_USAGE_URL;

function signInFailure(error: unknown): ProviderStreamEvent {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: 'error',
    error: message,
    // A missing or spent sign-in parks the run like a rejected key; a refresh that failed on the
    // network may succeed on the next request.
    errorCode: error instanceof ChatGptSignInRequiredError ? 'auth' : 'network',
  };
}

/** A refused request's error, worded for a sign-in rather than an API key. */
function refusedSignIn(event: ProviderStreamEvent): ProviderStreamEvent {
  const detail = (event.error ?? '').replace(/\s*Check BOOK_API_KEY.*$/s, '');
  return {
    ...event,
    error:
      `${detail} ChatGPT refused the signed-in account. Run \`book auth status\` to check it, ` +
      `or \`${CHATGPT_LOGIN_COMMAND}\` to sign in again.`,
  };
}

export async function* chatGptStream(
  config: AgentConfig,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  options?: ProviderStreamOptions,
): AsyncGenerator<ProviderStreamEvent> {
  let token: string;
  try {
    token = await chatGptAccessToken({ signal: options?.signal });
  } catch (error) {
    yield signInFailure(error);
    return;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let delivered = false;
    let refused = false;
    for await (const event of responsesStream(
      // Re-pinned here too: the plan token goes to OpenAI's API, whatever config reached this.
      { ...config, apiKey: token, baseUrl: chatGptEndpoints().apiBase },
      messages,
      tools,
      options,
      CHATGPT_ROUTE,
    )) {
      if (event.type === 'error' && event.errorCode === 'auth') {
        // One refresh and one retry, and only before anything reached the caller.
        if (attempt === 0 && !delivered) {
          refused = true;
          break;
        }
        yield refusedSignIn(event);
        return;
      }
      if (event.type === 'error' && event.errorCode === 'usage_limit') {
        yield { ...event, error: CHATGPT_USAGE_LIMIT_MESSAGE };
        return;
      }
      delivered = true;
      yield event;
    }
    if (!refused) return;
    try {
      token = await chatGptAccessToken({ signal: options?.signal, staleAccessToken: token });
    } catch (error) {
      yield signInFailure(error);
      return;
    }
  }
}

/**
 * `/login` and `/logout` in the TUI: Sign in with ChatGPT (experimental), the same flow as
 * `book auth login | logout`, reported as transcript notes. The transcript is saved with the
 * session, so the notes carry nothing secret: the authorize URL holds one-time values only, and
 * no `id_token_hint`.
 */

import { openInBrowser } from '../auth/browser.js';
import {
  CHATGPT_DISCONNECT_PATH,
  CHATGPT_USAGE_URL,
  signInWithChatGpt,
  signOutOfChatGpt,
} from '../auth/chatgpt-oauth.js';
import { chatGptProviderTarget, listChatGptPlanModels } from '../auth/chatgpt-setup.js';
import type { ProviderSaveRequest } from './model-options.js';

export interface ChatGptAuthHost {
  workspace: string;
  note(message: string): void;
  /** The `/model` save: writes the user file and updates the live provider registry. */
  saveProvider(request: ProviderSaveRequest): { ok: boolean; error?: string };
  env?: NodeJS.ProcessEnv;
  /** Replaces the system browser; tests follow the redirect themselves. */
  openBrowser?: (url: string) => unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loginWithChatGptInTui(
  host: ChatGptAuthHost,
  options: { newAccount?: boolean } = {},
): Promise<void> {
  let result;
  try {
    result = await signInWithChatGpt({
      env: host.env,
      newRegistration: options.newAccount,
      onAuthorizeUrl: (url) =>
        host.note(
          'Sign in with ChatGPT (experimental). Continue with ChatGPT in your browser; if it ' +
            `does not open, visit:\n${url}\nThe sign-in waits up to 5 minutes.`,
        ),
      openBrowser: host.openBrowser ?? ((url) => openInBrowser(url, host.env)),
    });
  } catch (error) {
    host.note(`✕ ChatGPT sign-in failed: ${messageOf(error)}`);
    return;
  }
  const lines = [`✓ Signed in with ChatGPT${result.email ? ` as ${result.email}` : ''}.`];
  if (result.firstSignIn) {
    lines.push(
      "You're using your ChatGPT plan: requests to a ChatGPT plan model count toward your " +
        `plan's limits. Manage usage: ${CHATGPT_USAGE_URL}`,
    );
  }
  try {
    const models = await listChatGptPlanModels({ env: host.env });
    const target = chatGptProviderTarget(host.workspace);
    if (!target.providerId) {
      lines.push(`[!] ${target.note}`);
    } else if (models.length === 0) {
      lines.push('[!] Your plan lists no models for Book.');
    } else {
      const saved = host.saveProvider({
        providerId: target.providerId,
        type: 'chatgpt',
        baseURL: '',
        apiKey: '',
        models,
        activeModelId: models[0].id,
        replaceModels: true,
        activate: false,
      });
      lines.push(
        saved.ok
          ? `${models.length} model${models.length === 1 ? '' : 's'} recorded under ` +
              `provider.${target.providerId}. Choose one in /model: the rows marked ` +
              '"ChatGPT plan (experimental)".'
          : `[!] The plan's models could not be saved: ${saved.error ?? 'unknown error'}`,
      );
    }
  } catch (error) {
    lines.push(`[!] Signed in, but the plan's model list could not be read: ${messageOf(error)}`);
  }
  host.note(lines.join('\n'));
}

export async function logoutOfChatGptInTui(host: ChatGptAuthHost): Promise<void> {
  try {
    const result = await signOutOfChatGpt({ env: host.env });
    if (!result.signedIn) {
      host.note('Not signed in with ChatGPT.');
      return;
    }
    host.note(
      result.revoked
        ? '✓ Signed out of ChatGPT: the sign-in is revoked and its tokens are deleted.'
        : '✓ Signed out of ChatGPT: the tokens on this machine are deleted. OpenAI did not ' +
            `confirm the revocation; to disconnect Book: ${CHATGPT_DISCONNECT_PATH}.`,
    );
  } catch (error) {
    host.note(`✕ ChatGPT sign-out failed: ${messageOf(error)}`);
  }
}

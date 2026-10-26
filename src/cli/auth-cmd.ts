/**
 * `book auth login | logout | status`: Sign in with ChatGPT, experimental and opt-in.
 *
 * `status` reads the record on disk and nothing else, so it runs without any credential, like
 * every other non-interactive subcommand. `login` is the only command that opens a browser.
 */

import { openInBrowser } from '../auth/browser.js';
import {
  CHATGPT_DISCONNECT_PATH,
  CHATGPT_USAGE_URL,
  chatGptSigninStatus,
  signInWithChatGpt,
  signOutOfChatGpt,
} from '../auth/chatgpt-oauth.js';
import { recordChatGptProvider } from '../auth/chatgpt-setup.js';
import { exit } from './exit.js';

const EXPERIMENTAL_NOTE =
  'Sign in with ChatGPT is experimental. Requests to a provider of type "chatgpt" are billed to ' +
  "your ChatGPT plan's usage, under OpenAI's terms; API-key providers are unaffected.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeExpiry(expiresAt: number, now = Date.now()): string {
  const minutes = Math.round((expiresAt - now) / 60_000);
  return minutes > 0 ? `expires in ${minutes} min` : 'expired; it refreshes on the next request';
}

export async function runAuthLoginCommand(options: {
  workspace: string;
  browser?: boolean;
  newAccount?: boolean;
}): Promise<void> {
  console.log(EXPERIMENTAL_NOTE);
  console.log();
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const result = await signInWithChatGpt({
      newRegistration: options.newAccount,
      signal: controller.signal,
      onAuthorizeUrl: (url) => {
        console.log('Continue with ChatGPT in your browser. If it does not open, visit:');
        console.log(`  ${url}`);
        console.log();
        console.log('Waiting for the browser (Ctrl+C cancels)...');
      },
      openBrowser: options.browser === false ? undefined : (url) => openInBrowser(url),
    });
    console.log(`Signed in with ChatGPT${result.email ? ` as ${result.email}` : ''}.`);
    if (result.firstSignIn) {
      console.log();
      console.log("You're using your ChatGPT plan");
      console.log(
        '  Requests to a "chatgpt" provider count toward your ChatGPT plan limits. ' +
          `Manage usage: ${CHATGPT_USAGE_URL}`,
      );
    }
    try {
      const setup = await recordChatGptProvider(options.workspace, { signal: controller.signal });
      if (setup.providerId && setup.models.length > 0) {
        console.log();
        console.log(
          `${setup.models.length} model${setup.models.length === 1 ? '' : 's'} recorded under ` +
            `provider.${setup.providerId} in ${setup.path}. Choose one with ` +
            `--model ${setup.providerId}/${setup.models[0].id}, or in /model.`,
        );
      } else if (setup.note) {
        console.log();
        console.log(`[!] ${setup.note}`);
      }
    } catch (error) {
      console.log();
      console.log(
        `[!] Signed in, but the plan's model list could not be read: ${errorMessage(error)}`,
      );
    }
  } catch (error) {
    console.error(`✕ ${errorMessage(error)}`);
    exit(1);
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}

export async function runAuthLogoutCommand(): Promise<void> {
  try {
    const result = await signOutOfChatGpt();
    if (!result.signedIn) {
      console.log('Not signed in with ChatGPT.');
      return;
    }
    console.log('Signed out: the ChatGPT tokens on this machine are deleted.');
    if (!result.revoked) {
      console.log(
        `[!] OpenAI did not confirm the sign-in was revoked. To disconnect Book: ${CHATGPT_DISCONNECT_PATH}.`,
      );
    }
  } catch (error) {
    console.error(`✕ ${errorMessage(error)}`);
    exit(1);
  }
}

export function runAuthStatusCommand(options: { json?: boolean } = {}): void {
  const status = chatGptSigninStatus();
  if (options.json) {
    console.log(JSON.stringify({ provider: 'chatgpt', experimental: true, ...status }, null, 2));
    return;
  }
  console.log(`Sign in with ChatGPT (experimental): ${describeStatus(status)}`);
  console.log(`  Record: ${status.path}`);
}

/** One line for `book auth status` and `book doctor`. */
export function describeStatus(status: ReturnType<typeof chatGptSigninStatus>): string {
  switch (status.state) {
    case 'unreadable':
      return `unreadable - ${status.error}`;
    case 'signed-out':
      return 'not signed in (run `book auth login`)';
    case 'signed-in': {
      const parts = [
        `signed in${status.email ? ` as ${status.email}` : ''}`,
        status.planUsage ? 'plan usage granted' : 'plan usage NOT granted - sign in again',
        `access token ${describeExpiry(status.expiresAt ?? 0)}`,
        status.refreshable
          ? 'refresh token stored'
          : 'no refresh token - sign in again after expiry',
      ];
      return parts.join('; ');
    }
  }
}

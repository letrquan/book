/**
 * `book auth login | logout | status`.
 *
 * Credential-free by contract, like every other non-interactive subcommand:
 * these are the commands a user reaches *because* their provider does not work,
 * so none of them may call the throwing `loadConfig`. They read settings
 * directly instead.
 */
import { createInterface } from 'node:readline/promises';
import { resolveSettings } from '../settings-loader.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import type { BookSettings } from '../settings.js';
import { missingClientIdMessage } from '../auth/oauth.js';
import {
  authClientIdEnvVar,
  listAuthProfiles,
  redirectUri,
  resolveAuthProfile,
  type AuthProfile,
} from '../auth/profiles.js';
import { describeExpiry } from '../auth/resolve.js';
import { isApiKeySelection, selectAuthProfile } from '../auth/selection.js';
import {
  clearCredentials,
  defaultAuthStorePath,
  deleteCredential,
  listCredentials,
  readAuthStore,
} from '../auth/store.js';
import { exit } from './exit.js';

export interface AuthCommandOptions {
  workspace: string;
  json?: boolean;
  /** Overrides used by tests; production resolves from BOOK_HOME. */
  home?: string;
}

export interface AuthLoginOptions extends AuthCommandOptions {
  noBrowser?: boolean;
  manual?: boolean;
  timeout?: string;
}

export interface AuthLogoutOptions extends AuthCommandOptions {
  all?: boolean;
}

/**
 * Settings without the credential requirement.
 *
 * A broken settings file must not stop `book auth status` from telling the user
 * where their credentials live, so a rejected resolve degrades to defaults with
 * a warning rather than throwing.
 */
function loadSettings(workspace: string): BookSettings {
  try {
    return resolveSettings(workspace);
  } catch (error) {
    console.warn(
      `⚠  Could not read settings (${error instanceof Error ? error.message : String(error)}); ` +
        'showing built-in auth profiles only.',
    );
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/** BOOK_PROVIDER as loadConfig reads it, so status and the run agree. */
function providerOverride(): 'anthropic' | 'openai' | 'auto' {
  const raw = process.env.BOOK_PROVIDER?.trim().toLowerCase();
  return raw === 'anthropic' || raw === 'openai' ? raw : 'auto';
}

export function runAuthStatusCommand(options: AuthCommandOptions, now = Date.now()): void {
  const settings = loadSettings(options.workspace);
  const store = { home: options.home };
  const read = readAuthStore(store);
  const credentials = listCredentials(store);
  const profiles = listAuthProfiles(settings);

  let selection: ReturnType<typeof selectAuthProfile> | undefined;
  let selectionError: string | undefined;
  try {
    selection = selectAuthProfile({
      settings,
      // The same provider filter loadConfig applies. Hardcoding 'auto' made
      // status report "API key" for a run that would in fact spend a
      // subscription, which is the one question this command answers.
      providerType: providerOverride(),
      hasApiKey: Boolean(process.env.BOOK_API_KEY),
      store,
    });
  } catch (error) {
    selectionError = error instanceof Error ? error.message : String(error);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          storePath: defaultAuthStorePath(options.home),
          storeStatus: read.status,
          active: selection
            ? { profile: selection.profile.id, explicit: selection.explicit }
            : null,
          selectionError: selectionError ?? null,
          credentials,
          profiles: profiles.map((profile) => ({
            id: profile.id,
            label: profile.label,
            providerType: profile.providerType,
            baseUrl: profile.baseUrl,
            clientIdConfigured: Boolean(profile.clientId),
            loggedIn: credentials.some((credential) => credential.profile === profile.id),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('Book Auth');
  console.log('=========');
  console.log();
  console.log('Credential store:', defaultAuthStorePath(options.home));
  if (read.status === 'unreadable') {
    console.log('  ! Unreadable (' + read.error + '). Every stored credential is being ignored.');
  } else if (read.status === 'missing') {
    console.log('  (no credentials stored yet)');
  }
  console.log();

  console.log('Active credential:');
  if (selectionError) {
    console.log('  ! ' + selectionError);
  } else if (!selection) {
    console.log('  API key (BOOK_API_KEY or provider.<id>.apiKey)');
  } else {
    console.log(
      `  ${selection.profile.id} — ${selection.profile.label}` +
        (selection.explicit ? ' (selected by auth.profile)' : ' (only matching login)'),
    );
    if (!selection.credentialPresent) {
      console.log(`  ! Nothing logged in. Run: book auth login ${selection.profile.id}`);
    }
  }
  console.log();

  console.log('Stored credentials:');
  if (credentials.length === 0) {
    console.log('  (none)');
  } else {
    for (const credential of credentials) {
      console.log(
        `  ${credential.profile}${credential.account ? ` (${credential.account})` : ''}: ` +
          (credential.kind === 'oauth'
            ? describeExpiry(
                {
                  accessToken: '',
                  expiresAt: credential.expiresAt,
                  refreshToken: credential.refreshable ? 'x' : undefined,
                },
                now,
              )
            : 'API key'),
      );
    }
  }
  console.log();

  console.log('Profiles:');
  for (const profile of profiles) {
    const flags = [
      profile.providerType,
      profile.clientId
        ? 'client id configured'
        : `no client id — set ${authClientIdEnvVar(profile.id)}`,
    ];
    console.log(`  ${profile.id}: ${profile.label} [${flags.join(', ')}]`);
  }
}

function resolveProfileOrExit(
  profileId: string | undefined,
  settings: BookSettings,
): AuthProfile | undefined {
  const available = listAuthProfiles(settings);
  if (!profileId) {
    console.error('Which profile? Available: ' + available.map((p) => p.id).join(', '));
    console.error('  book auth login <profile>');
    exit(1);
    return undefined;
  }
  if (isApiKeySelection(profileId)) {
    console.error(
      '"api-key" is not a login profile — it is the value of auth.profile that turns ' +
        'subscription auth off. Set BOOK_API_KEY instead.',
    );
    exit(1);
    return undefined;
  }

  const profile = resolveAuthProfile(profileId, settings);
  if (!profile) {
    console.error(
      `Unknown auth profile "${profileId}". Available: ${available.map((p) => p.id).join(', ')}`,
    );
    console.error(
      `Declare a custom one under auth.profiles.${profileId} with authorizeUrl, tokenUrl, and baseUrl.`,
    );
    exit(1);
    return undefined;
  }
  return profile;
}

async function promptForRedirectUrl(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question('Paste the URL your browser was redirected to: ');
  } finally {
    rl.close();
  }
}

export async function runAuthLoginCommand(
  profileId: string | undefined,
  options: AuthLoginOptions,
): Promise<void> {
  const settings = loadSettings(options.workspace);
  const profile = resolveProfileOrExit(profileId, settings);
  if (!profile) return;

  if (!profile.clientId) {
    console.error(missingClientIdMessage(profile));
    exit(1);
    return;
  }

  // Integer seconds only, and capped at what setTimeout can represent: a
  // larger delay silently collapses to 1ms, so "--timeout 3000000" would fail
  // the login instantly rather than waiting longer.
  const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);
  let timeoutMs: number | undefined;
  if (options.timeout !== undefined) {
    const seconds = Number(options.timeout);
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_TIMEOUT_SECONDS) {
      console.error(
        `--timeout must be a whole number of seconds between 1 and ${MAX_TIMEOUT_SECONDS}.`,
      );
      exit(1);
      return;
    }
    timeoutMs = seconds * 1000;
  }

  console.log(`Signing in to ${profile.label}.`);
  if (!options.manual) {
    console.log(`Listening on ${redirectUri(profile)} for the redirect.`);
  }

  // Imported here rather than at module scope: this pulls in the loopback
  // listener and with it `node:http`, which nothing else in Book loads. A
  // static import would evaluate it on every `book` invocation - every TUI
  // launch, every `--print`, every `book config get` - to serve a command
  // almost nobody runs. `cli/doctor.ts` defers its own imports the same way.
  const { runOAuthLogin } = await import('../auth/login.js');

  try {
    const { credential } = await runOAuthLogin({
      profile,
      manual: options.manual,
      noBrowser: options.noBrowser,
      readRedirectUrl: promptForRedirectUrl,
      timeoutMs,
      store: { home: options.home },
      events: {
        onAuthorizeUrl(url, opened) {
          console.log();
          console.log(opened ? 'Opened your browser at:' : 'Open this URL to continue:');
          console.log('  ' + url);
          console.log();
        },
      },
    });
    const account = credential.tokens?.account;
    console.log(`Signed in to ${profile.id}${account ? ` as ${account}` : ''}.`);
    if (!settings.auth?.profile) {
      console.log(
        'Book will use this credential when no API key is configured. To pin it, set ' +
          `BOOK_AUTH_PROFILE=${profile.id}, or add {"auth":{"profile":"${profile.id}"}} to ` +
          '<BOOK_HOME>/settings.json.',
      );
    }
  } catch (error) {
    console.error('Login failed: ' + (error instanceof Error ? error.message : String(error)));
    exit(1);
  }
}

export function runAuthLogoutCommand(
  profileId: string | undefined,
  options: AuthLogoutOptions,
): void {
  const store = { home: options.home };

  // `book auth logout codex --all` reads as "all sessions for codex" but would
  // wipe every profile, costing a browser round trip to restore. Refuse rather
  // than silently ignoring the argument.
  if (options.all && profileId) {
    console.error('Pass a profile or --all, not both.');
    exit(1);
    return;
  }

  if (options.all) {
    // A corrupt store is exactly what someone runs logout to recover from, so
    // the writer's refusal has to arrive as a message, not a stack trace.
    const removed = withStoreErrors(() => clearCredentials(store));
    if (removed === undefined) return;
    console.log(
      removed === 0 ? 'No stored credentials to remove.' : `Removed ${removed} credential(s).`,
    );
    return;
  }

  if (!profileId) {
    const stored = listCredentials(store);
    console.error(
      stored.length === 0
        ? 'No stored credentials. Nothing to log out of.'
        : 'Which profile? Stored: ' + stored.map((c) => c.profile).join(', ') + ' (or --all)',
    );
    exit(1);
    return;
  }

  const removed = withStoreErrors(() => deleteCredential(profileId, store));
  if (removed === undefined) return;
  console.log(
    removed
      ? `Removed the stored "${profileId}" credential.`
      : `No stored credential for "${profileId}".`,
  );
}

/**
 * Report a store the writer refuses to touch, and say how to get out of it.
 *
 * Returns undefined when the operation was refused, after exiting non-zero.
 */
function withStoreErrors<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Delete the file to start over: it holds only credentials you can re-obtain.');
    exit(1);
    return undefined;
  }
}

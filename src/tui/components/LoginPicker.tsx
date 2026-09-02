/**
 * `/login` — the subscription OAuth flow, driven from inside the TUI.
 *
 * The flow itself is not reimplemented here. `runOAuthLogin` was written
 * host-agnostically for exactly this reason: every step a caller might want to
 * render is a callback, so the overlay renders and the auth module still owns
 * PKCE, the loopback listener, and the token exchange.
 *
 * Three properties this component is responsible for:
 *
 * - **A cancelled login binds nothing.** Esc aborts the AbortController, and
 *   the effect's cleanup aborts on unmount too — otherwise closing the overlay
 *   mid-flight would leave a listener holding the registered redirect port for
 *   the rest of the session.
 * - **A missing client id costs no port.** Enter on a profile with no id shows
 *   the same guidance the CLI prints, without starting a flow that cannot
 *   succeed.
 * - **Success is not activation.** Storing a credential does not make a session
 *   spend it (see `applyAuthLogin`), so the success step asks, and says what
 *   declining means.
 */
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ListPicker } from './ListPicker.js';
import { useTheme } from '../theme.js';
import { runOAuthLogin, DEFAULT_LOGIN_TIMEOUT_MS, type LoginOptions } from '../../auth/login.js';
import { missingClientIdMessage } from '../../auth/oauth.js';
import { redirectUri, type AuthProfile } from '../../auth/profiles.js';
import type { AuthStoreOptions } from '../../auth/store.js';

export type LoginRunner = (options: LoginOptions) => Promise<{ credential: { profile: string } }>;

/** What activation would do, resolved before the user is asked to consent. */
export type ActivationPreview =
  { ok: true; model: string; baseUrl: string; warning?: string } | { ok: false; error: string };

export interface LoginPickerProps {
  profiles: AuthProfile[];
  /** Profile ids with a credential already stored. */
  signedIn: readonly string[];
  /** The profile this session is currently spending, if any. */
  activeProfile?: string;
  /** `/login <profile>` preselects rather than auto-starting: a flow that opens
   * a browser and binds a port should begin on a keystroke the user aimed. */
  initialProfileId?: string;
  /** Persists the choice and re-points the live config; see `applyAuthLogin`. */
  onActivate: (profile: AuthProfile) => { ok: boolean; error?: string };
  /**
   * What activation would actually do. Consulted *before* asking, so a
   * combination that cannot work is refused instead of consented to, and the
   * prompt names the model and endpoint the session will really use rather
   * than the profile's own — the two differ whenever an explicit override wins.
   */
  previewActivation: (profile: AuthProfile) => ActivationPreview;
  /** Called after a credential is stored, so the parent can re-read the store. */
  onSignedIn?: (profileId: string) => void;
  onClose: () => void;
  /** Injected by tests so the suite never opens a browser or binds a port. */
  runLogin?: LoginRunner;
  /** Injected by tests so credentials land in a temp BOOK_HOME. */
  store?: AuthStoreOptions;
  timeoutMs?: number;
}

type View =
  | { kind: 'list' }
  | { kind: 'running'; profile: AuthProfile }
  | { kind: 'activate'; profile: AuthProfile; model: string; baseUrl: string; warning?: string }
  | { kind: 'message'; tone: 'error' | 'success'; text: string; hint?: string };

interface Progress {
  url?: string;
  opened?: boolean;
  port?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function LoginPicker({
  profiles,
  signedIn,
  activeProfile,
  onActivate,
  previewActivation,
  onSignedIn,
  onClose,
  initialProfileId,
  runLogin = runOAuthLogin as LoginRunner,
  store,
  timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
}: LoginPickerProps) {
  const theme = useTheme();
  // The cursor itself now lives in `ListPicker`; this only decides where it
  // starts. `/login <profile>` wins over the active profile, because naming one
  // explicitly is the stronger signal.
  const initialIndex = useMemo(() => {
    for (const id of [initialProfileId, activeProfile].filter(Boolean)) {
      const index = profiles.findIndex((profile) => profile.id === id);
      if (index >= 0) return index;
    }
    return 0;
  }, [activeProfile, initialProfileId, profiles]);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [progress, setProgress] = useState<Progress>({});
  // Separate from `view` on purpose: the effect that runs the login keys on
  // this, and progress updates must not restart the flow they are reporting.
  // A fresh object per start is what re-fires the effect — identity, not a
  // counter.
  const [run, setRun] = useState<{ profile: AuthProfile }>();

  useEffect(() => {
    if (!run) return;
    const controller = new AbortController();
    let live = true;
    const { profile } = run;

    void (async () => {
      try {
        await runLogin({
          profile,
          store,
          timeoutMs,
          signal: controller.signal,
          events: {
            onAuthorizeUrl: (url, opened) => {
              if (live) setProgress((current) => ({ ...current, url, opened }));
            },
            onWaiting: ({ port }) => {
              if (live) setProgress((current) => ({ ...current, port }));
            },
          },
        });
        if (!live) return;
        setRun(undefined);
        onSignedIn?.(profile.id);
        if (profile.id === activeProfile) {
          setView({
            kind: 'message',
            tone: 'success',
            text: `Signed in to ${profile.label}.`,
            hint: 'This session is already spending that profile.',
          });
          return;
        }
        // Resolve what activation would do before offering it. A combination
        // that cannot work is reported now, while the credential is merely
        // stored — consenting to it would persist `auth.profile` globally.
        const preview = previewActivation(profile);
        setView(
          preview.ok
            ? {
                kind: 'activate',
                profile,
                model: preview.model,
                baseUrl: preview.baseUrl,
                warning: preview.warning,
              }
            : {
                kind: 'message',
                tone: 'error',
                text: `Signed in to ${profile.label}, but this session cannot spend it: ${preview.error}`,
                hint: 'The credential is stored; fix the above and run /login again.',
              },
        );
      } catch (error) {
        if (!live) return;
        setRun(undefined);
        setView({ kind: 'message', tone: 'error', text: errorText(error) });
      }
    })();

    // Runs on cancel *and* on unmount, so a closed overlay never leaves the
    // loopback listener holding the redirect port.
    return () => {
      live = false;
      controller.abort();
    };
  }, [run, runLogin, store, timeoutMs, activeProfile, previewActivation, onSignedIn]);

  const start = useCallback((profile: AuthProfile) => {
    if (!profile.clientId) {
      setView({ kind: 'message', tone: 'error', text: missingClientIdMessage(profile) });
      return;
    }
    setProgress({});
    setView({ kind: 'running', profile });
    setRun({ profile });
  }, []);

  useInput(
    (input, key) => {
      if (view.kind === 'running') {
        // Cancel only. Abort happens in the effect cleanup when `run` clears.
        if (key.escape) {
          setRun(undefined);
          setView({ kind: 'list' });
        }
        return;
      }

      if (view.kind === 'activate') {
        const answer = input.toLowerCase();
        if (key.escape || answer === 'n') {
          setView({
            kind: 'message',
            tone: 'success',
            text: `Signed in to ${view.profile.label}, but this session still uses its previous credential.`,
            hint: `Run /login again, or set auth.profile to "${view.profile.id}", to spend it.`,
          });
          return;
        }
        if (key.return || answer === 'y') {
          const result = onActivate(view.profile);
          setView(
            result.ok
              ? {
                  kind: 'message',
                  tone: 'success',
                  text: `Now spending ${view.profile.label} on this and future sessions.`,
                  hint: `Model: ${view.model} · ${view.baseUrl}`,
                }
              : { kind: 'message', tone: 'error', text: result.error ?? 'Could not activate.' },
          );
        }
        return;
      }

      if (view.kind === 'message') {
        if (key.escape) onClose();
        else setView({ kind: 'list' });
        return;
      }

      if (key.escape) onClose();
      // The list stage is `ListPicker`'s; this handler is inactive there. Ink
      // fans every keypress to every registered handler, so leaving both live
      // would double-fire Enter and Esc.
    },
    { isActive: view.kind !== 'list' },
  );

  if (view.kind === 'running') {
    const seconds = Math.round(timeoutMs / 1000);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text bold color={theme.brand}>
          Signing in to {view.profile.label}
        </Text>
        {progress.url ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.text}>
              {progress.opened ? 'Opened your browser at:' : 'Open this URL to continue:'}
            </Text>
            <Text color={theme.subtle} wrap="wrap">
              {progress.url}
            </Text>
          </Box>
        ) : (
          <Text color={theme.subtle}>Preparing the authorization request…</Text>
        )}
        {progress.port !== undefined && (
          <Box marginTop={1}>
            <Text color={theme.subtle}>
              Waiting for the redirect on {redirectUri(view.profile, progress.port)} · times out in{' '}
              {seconds}s
            </Text>
          </Box>
        )}
        <Text color={theme.subtle} dimColor>
          Esc cancel
        </Text>
      </Box>
    );
  }

  if (view.kind === 'activate') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text bold color={theme.success}>
          Signed in to {view.profile.label}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text}>Use this subscription for future turns?</Text>
          <Text color={theme.subtle}>
            Saves auth.profile to your user settings and switches this session to {view.model} at{' '}
            {view.baseUrl}.
          </Text>
          {view.warning && (
            <Text color={theme.warning ?? theme.subtle} wrap="wrap">
              ! {view.warning}
            </Text>
          )}
        </Box>
        <Text color={theme.subtle} dimColor>
          Enter activate · n keep current credential · Esc keep current credential
        </Text>
      </Box>
    );
  }

  if (view.kind === 'message') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text color={view.tone === 'error' ? theme.error : theme.success} wrap="wrap">
          {view.tone === 'error' ? '✕ ' : '✓ '}
          {view.text}
        </Text>
        {view.hint && (
          <Text color={theme.subtle} wrap="wrap">
            {view.hint}
          </Text>
        )}
        <Text color={theme.subtle} dimColor>
          Enter back · Esc close
        </Text>
      </Box>
    );
  }

  return (
    <ListPicker
      title="Sign in with a subscription"
      subtitle="Authorizes Book against a provider subscription instead of an API key."
      items={profiles.map((profile) => {
        const notes = [
          signedIn.includes(profile.id) ? 'signed in' : undefined,
          profile.id === activeProfile ? 'active' : undefined,
          profile.clientId ? undefined : 'no client id',
        ].filter(Boolean);
        return {
          key: profile.id,
          label: `${profile.id.padEnd(10)} ${profile.label}`,
          note: notes.length > 0 ? `(${notes.join(', ')})` : undefined,
          accent: profile.id === activeProfile,
        };
      })}
      initialIndex={initialIndex}
      emptyText="No auth profiles are configured."
      enterHint="sign in"
      escHint="cancel"
      onSelect={(index) => {
        const profile = profiles[index];
        if (profile) start(profile);
      }}
      onCancel={onClose}
    />
  );
}

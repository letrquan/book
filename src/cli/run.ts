import { render } from 'ink';
import { createElement } from 'react';
import { freezeAgentConfig, loadConfig } from '../config.js';
import { runHeadless } from '../headless.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { SessionStore } from '../session/store.js';
import { connectMcpServers } from '../mcp.js';
import { exit } from './exit.js';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { AgentConfig } from '../types/runtime.js';
import type { RewindSnapshotStoreInterface, TurnCheckpointRecordData } from '../types/sessions.js';
import { resolveSessionBootstrap } from '../session/resolve.js';
import {
  createRewindSnapshotStore,
  createUnavailableRewindSnapshotStore,
} from '../rewind/snapshot-store.js';
import { createEphemeralRewindEnvironment } from '../rewind/environment.js';

const SESSION_ROOT = join(homedir(), '.book', 'sessions');
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const DISABLE_SGR_MOUSE = '\x1b[?1006l';
const DISABLE_MOUSE_TRACKING = '\x1b[?1000l';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

function collectSnapshotReferences(store: SessionStore, cwd: string): Set<string> {
  const ids = new Set<string>();
  for (const session of store.list().filter((meta) => meta.cwd === normalizeCwd(cwd))) {
    for (const record of store.readRecords(session.id)) {
      if (record.type !== 'turn_checkpoint') continue;
      const snapshotId = (record.data as TurnCheckpointRecordData)?.checkpoint?.snapshotId;
      if (snapshotId) ids.add(snapshotId);
    }
  }
  return ids;
}

function normalizeCwd(cwd: string): string {
  const normalized = resolve(cwd);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function enterInteractiveScreen(
  stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'write'> = process.stdout,
): () => void {
  if (!stdout.isTTY) return () => {};

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdout.write(DISABLE_SGR_MOUSE + DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN);
    process.off('exit', restore);
  };

  // Leave mouse reporting disabled so the terminal owns drag selection and copy.
  stdout.write(ENTER_ALT_SCREEN + DISABLE_SGR_MOUSE + DISABLE_MOUSE_TRACKING);
  process.once('exit', restore);
  return restore;
}

export async function runMainAction(options: Record<string, unknown>): Promise<void> {
  try {
    const config = loadConfig(options.workspace as string | undefined, {
      settingsOverridePath: options.settings as string | undefined,
      noSettings: options.settings === false,
      modelOverride: options.model as string | undefined,
      allowMissingApiKey: options.print === undefined && !options.scrollback,
    }) as AgentConfig;
    if (options.effort) config.effort = options.effort as AgentConfig['effort'];
    if (options.maxTurns) config.maxTurns = parseInt(options.maxTurns as string, 10);
    if (options.agents) {
      const agentsMode = String(options.agents);
      if (!['adaptive', 'manual', 'off'].includes(agentsMode)) {
        throw new Error('--agents must be adaptive, manual, or off');
      }
      config.settings.agents.mode = agentsMode as 'adaptive' | 'manual' | 'off';
    }
    if (options.provider) {
      const VALID_PROVIDERS = new Set(['anthropic', 'openai', 'auto']);
      const raw = String(options.provider).trim().toLowerCase();
      if (VALID_PROVIDERS.has(raw)) {
        config.provider = raw as AgentConfig['provider'];
      }
    }
    freezeAgentConfig(config);

    // Headless / print mode.
    if (options.print !== undefined) {
      // Connect MCP servers and merge their tools into the registry.
      const mcp = await connectMcpServers(config.workspace);
      const registry = createDefaultRegistry({ agents: config.settings.agents.mode !== 'off' });
      if (mcp.tools.length > 0) {
        registry.registerAll(mcp.tools);
      }

      const rawMode = ((options.permissionMode as string) ?? 'default') as string;
      const mode = (rawMode === 'acceptEdits' ? 'accept-edits' : rawMode) as
        'default' | 'accept-edits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

      const sessionStore = (options.sessionPersistence as boolean)
        ? new SessionStore(SESSION_ROOT)
        : undefined;
      // Purge old sessions at startup.
      sessionStore?.cleanup(30);

      const bootstrap = resolveSessionBootstrap(sessionStore, {
        cwd: config.workspace,
        resume: options.resume as string | undefined,
        continue: options.continue as boolean | undefined,
        sessionId: options.sessionId as string | undefined,
        sessionName: options.name as string | undefined,
        forkSession: options.forkSession as boolean | undefined,
      });

      await runHeadless(config, registry, {
        prompt: typeof options.print === 'string' ? (options.print as string) : undefined,
        inputFormat: options.inputFormat as 'text' | 'stream-json',
        outputFormat: options.outputFormat as 'text' | 'json' | 'stream-json',
        history: bootstrap.history,
        transcript: bootstrap.transcript,
        compactBoundaries: bootstrap.compactBoundaries,
        mode,
        maxTurns: options.maxTurns ? parseInt(options.maxTurns as string, 10) : undefined,
        maxBudgetUsd: options.maxBudgetUsd ? parseFloat(options.maxBudgetUsd as string) : undefined,
        verbose: options.verbose as boolean | undefined,
        jsonSchema: options.jsonSchema ? JSON.parse(options.jsonSchema as string) : undefined,
        sessionStore,
        sessionId: bootstrap.sessionId,
        sessionName: bootstrap.sessionName,
        forkSession: false,
        sessionCreated: bootstrap.created,
        persistSession: options.sessionPersistence as boolean | undefined,
        includeHookEvents: options.includeHookEvents as boolean | undefined,
        includePartialMessages: options.includePartialMessages as boolean | undefined,
        promptSuggestions: options.promptSuggestions as boolean | undefined,
      });
      return;
    }

    // Interactive TUI mode.
    const rawMode = ((options.permissionMode as string) ?? 'default') as string;
    const mode = (rawMode === 'acceptEdits' ? 'accept-edits' : rawMode) as
      'default' | 'accept-edits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
    if (options.scrollback) {
      const { runScrollbackSession } = await import('./scrollback.js');
      await runScrollbackSession(config, { mode });
      return;
    }

    const sessionStore = (options.sessionPersistence as boolean)
      ? new SessionStore(SESSION_ROOT)
      : undefined;
    sessionStore?.cleanup(30);
    const ephemeralRewind = sessionStore
      ? undefined
      : createEphemeralRewindEnvironment(config.workspace);
    const timelineStore = sessionStore ?? ephemeralRewind!.timelineStore;
    let snapshotStore: RewindSnapshotStoreInterface = sessionStore
      ? createRewindSnapshotStore(config.workspace)
      : ephemeralRewind!.snapshotStore;
    if (sessionStore) {
      try {
        snapshotStore.cleanup(collectSnapshotReferences(sessionStore, config.workspace), 30);
      } catch (error) {
        snapshotStore = createUnavailableRewindSnapshotStore(
          `Code rewind unavailable: snapshot cleanup failed (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }
    const bootstrap = resolveSessionBootstrap(sessionStore, {
      cwd: config.workspace,
      resume: options.resume as string | undefined,
      continue: options.continue as boolean | undefined,
      sessionId: options.sessionId as string | undefined,
      sessionName: options.name as string | undefined,
      forkSession: options.forkSession as boolean | undefined,
    });
    if (!sessionStore) {
      timelineStore.create({
        id: bootstrap.sessionId,
        cwd: config.workspace,
        name: bootstrap.sessionName,
      });
    }

    const [{ App }, { loadInteractiveAssets }] = await Promise.all([
      import('../tui/app.js'),
      import('../tui/interactive-assets.js'),
    ]);
    const interactiveAssets = loadInteractiveAssets(config);
    let app: ReturnType<typeof render> | undefined;
    const redrawViewport = () => {
      app?.clear();
      process.stdout.write('\x1b[H\x1b[2J');
    };
    const restoreScreen = config.accessibility.screenReader
      ? () => {}
      : enterInteractiveScreen(process.stdout);
    try {
      app = render(
        createElement(App, {
          config,
          interactiveAssets,
          redrawViewport,
          session: { ...bootstrap, store: sessionStore, timelineStore, snapshotStore },
        }),
        {
          exitOnCtrlC: false,
          isScreenReaderEnabled: config.accessibility.screenReader,
        },
      );
      await app.waitUntilExit();
    } finally {
      app?.cleanup();
      restoreScreen();
      ephemeralRewind?.dispose();
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    exit(1);
  }
}

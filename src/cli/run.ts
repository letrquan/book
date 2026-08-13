import { render } from 'ink';
import { createElement } from 'react';
import { freezeAgentConfig, loadConfig } from '../config.js';
import { runHeadless } from '../headless.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { SessionStore } from '../session/store.js';
import { connectMcpServers, disconnectMcpServers } from '../mcp.js';
import { McpSessionHost } from '../mcp-host.js';
import { mcpServersToRecord, partitionMcpServersByApproval } from '../mcp-approvals.js';
import { resolveMcpServerList } from '../mcp-config.js';
import { exit } from './exit.js';
import { join } from 'path';
import type { AgentConfig } from '../types/runtime.js';
import type { RewindSnapshotStoreInterface } from '../types/sessions.js';
import { resolveSessionBootstrap } from '../session/resolve.js';
import {
  createRewindSnapshotStore,
  createUnavailableRewindSnapshotStore,
} from '../rewind/snapshot-store.js';
import { createEphemeralRewindEnvironment } from '../rewind/environment.js';
import {
  cleanupDebugLogs,
  DEFAULT_LOCAL_DATA_RETENTION_DAYS,
  getDebugLogPath,
} from '../debug-log.js';
import { installInkScrollRenderer } from './ink-scroll-renderer.js';
import { isInkIncrementalRendererPatched } from './ink-patch.js';
import { resolveTuiRendererMode } from './tui-renderer-mode.js';
import { resolvePermissionMode } from '../permission-mode.js';
import { spawn } from 'node:child_process';
import { resolveBookHome } from '../book-home.js';

const SESSION_ROOT = join(resolveBookHome(), 'sessions');
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const ENABLE_MOUSE_TRACKING = '\x1b[?1000h';
const ENABLE_SGR_MOUSE = '\x1b[?1006h';
const DISABLE_SGR_MOUSE = '\x1b[?1006l';
const DISABLE_MOUSE_TRACKING = '\x1b[?1000l';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const WSL_TERMINAL_BRIDGE_SCRIPT = `
for process in /proc/[0-9]*; do
  [ -r "$process/environ" ] || continue
  /usr/bin/grep -Fzqx "WT_SESSION=$2" "$process/environ" 2>/dev/null || continue
  target=$(/usr/bin/readlink "$process/fd/1" 2>/dev/null) || continue
  case "$target" in
    /dev/pts/*)
      /usr/bin/printf '%s' "$1" > "$process/fd/1"
      exit $?
      ;;
  esac
done
exit 1
`.trim();

export function shouldBridgeWslTerminal(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const sharedVariables = (env.WSLENV ?? '').split(':').map((entry) => entry.split('/')[0]);
  return platform === 'win32' && Boolean(env.WT_SESSION) && sharedVariables.includes('WT_SESSION');
}

function writeTerminalControl(stdout: Pick<NodeJS.WriteStream, 'write'>, sequence: string): void {
  stdout.write(sequence);
  if (stdout !== process.stdout || !shouldBridgeWslTerminal()) return;

  // A Windows process launched from WSL writes through an inner ConPTY. Find
  // the WSL proxy for this terminal session and write modes to its real PTY.
  try {
    const bridge = spawn(
      'wsl.exe',
      [
        '-e',
        'sh',
        '-c',
        WSL_TERMINAL_BRIDGE_SCRIPT,
        'book-terminal-bridge',
        sequence,
        process.env.WT_SESSION!,
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    bridge.on('error', () => {});
    bridge.unref();
  } catch {
    // Terminal restoration remains best effort when the WSL bridge is unavailable.
  }
}

function collectSnapshotReferences(store: SessionStore, cwd: string): Set<string> {
  return store.listSnapshotReferences(cwd);
}

export function enterInteractiveScreen(
  stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'write'> = process.stdout,
): () => void {
  const bridgeWslTerminal = shouldBridgeWslTerminal();
  if (!stdout.isTTY && !bridgeWslTerminal) return () => {};

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    writeTerminalControl(stdout, DISABLE_SGR_MOUSE + DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN);
    process.off('exit', restore);
  };

  // Shift+drag remains available for terminal-native selection while mouse
  // reporting keeps transcript wheel scrolling and tool-row clicks working.
  writeTerminalControl(stdout, ENTER_ALT_SCREEN + ENABLE_MOUSE_TRACKING + ENABLE_SGR_MOUSE);
  process.once('exit', restore);
  return restore;
}

export async function runMainAction(options: Record<string, unknown>): Promise<void> {
  try {
    const requestedWorkspace = options.workspace as string | undefined;
    const config = loadConfig(requestedWorkspace, {
      settingsOverridePath: options.settings as string | undefined,
      noSettings: options.settings === false,
      runMigrations: options.settings !== false,
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
    cleanupDebugLogs(DEFAULT_LOCAL_DATA_RETENTION_DAYS, getDebugLogPath());

    // Headless / print mode.
    if (options.print !== undefined) {
      // Connect approved MCP servers and merge their tools into the registry.
      // Project-declared servers need a prior interactive approval; there is
      // no prompt to give one here.
      const declaredMcpServers = resolveMcpServerList(config.workspace);
      const mcpPartition = partitionMcpServersByApproval(declaredMcpServers, config.settings);
      for (const server of mcpPartition.pending) {
        console.warn(
          `⚠  Skipping MCP server "${server.name}" (${server.path}): project-declared servers require one-time approval. Approve it in an interactive session first.`,
        );
      }
      const mcp = await connectMcpServers(config.workspace, {
        servers: mcpServersToRecord(mcpPartition.allowed),
      });
      try {
        const registry = createDefaultRegistry({ agents: config.settings.agents.mode !== 'off' });
        if (mcp.tools.length > 0) {
          registry.registerAll(mcp.tools);
        }

        const mode = resolvePermissionMode(config.settings, options.permissionMode);

        const sessionStore = (options.sessionPersistence as boolean)
          ? new SessionStore(SESSION_ROOT)
          : undefined;
        const bootstrap = resolveSessionBootstrap(sessionStore, {
          cwd: config.workspace,
          resume: options.resume as string | undefined,
          continue: options.continue as boolean | undefined,
          sessionId: options.sessionId as string | undefined,
          sessionName: options.name as string | undefined,
          forkSession: options.forkSession as boolean | undefined,
        });
        sessionStore?.cleanup(DEFAULT_LOCAL_DATA_RETENTION_DAYS, new Set([bootstrap.sessionId]));

        await runHeadless(config, registry, {
          prompt: typeof options.print === 'string' ? (options.print as string) : undefined,
          inputFormat: options.inputFormat as 'text' | 'stream-json',
          outputFormat: options.outputFormat as 'text' | 'json' | 'stream-json',
          history: bootstrap.history,
          transcript: bootstrap.transcript,
          compactBoundaries: bootstrap.compactBoundaries,
          mode,
          maxTurns: options.maxTurns ? parseInt(options.maxTurns as string, 10) : undefined,
          maxBudgetUsd: options.maxBudgetUsd
            ? parseFloat(options.maxBudgetUsd as string)
            : undefined,
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
      } finally {
        await disconnectMcpServers(mcp.connections);
      }
      return;
    }

    // Interactive TUI mode.
    const mode = resolvePermissionMode(config.settings, options.permissionMode);
    if (options.scrollback) {
      const { runScrollbackSession } = await import('./scrollback.js');
      await runScrollbackSession(config, { mode });
      return;
    }

    const sessionStore = (options.sessionPersistence as boolean)
      ? new SessionStore(SESSION_ROOT)
      : undefined;
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
    sessionStore?.cleanup(DEFAULT_LOCAL_DATA_RETENTION_DAYS, new Set([bootstrap.sessionId]));
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
    // Session MCP owner: user-global and previously approved project servers
    // connect in the background; unapproved project servers surface as a
    // one-time trust prompt inside the TUI.
    const mcpHost = new McpSessionHost(config.workspace, config.settings);
    mcpHost.start();
    let app: ReturnType<typeof render> | undefined;
    const redrawViewport = () => {
      app?.clear();
      process.stdout.write('\x1b[H\x1b[2J');
    };
    const restoreScreen = config.accessibility.screenReader
      ? () => {}
      : enterInteractiveScreen(process.stdout);
    try {
      const rendererMode = resolveTuiRendererMode(process.env.BOOK_TUI_RENDERER, {
        isTTY: process.stdout.isTTY === true,
        screenReader: config.accessibility.screenReader,
        incrementalRendererPatched: isInkIncrementalRendererPatched(),
        platform: process.platform,
      });
      await installInkScrollRenderer(rendererMode === 'experimental-scroll');
      app = render(
        createElement(App, {
          config,
          permissionMode: mode,
          interactiveAssets,
          redrawViewport,
          mcp: mcpHost,
          session: { ...bootstrap, store: sessionStore, timelineStore, snapshotStore },
        }),
        {
          exitOnCtrlC: false,
          isScreenReaderEnabled: config.accessibility.screenReader,
          incrementalRendering: rendererMode !== 'safe',
          maxFps: 60,
        },
      );
      await app.waitUntilExit();
    } finally {
      app?.cleanup();
      restoreScreen();
      await mcpHost.dispose();
      ephemeralRewind?.dispose();
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    exit(1);
  }
}

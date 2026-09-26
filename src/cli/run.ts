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
import { collectWithheldProjectNotices } from '../project-approval-notices.js';
import { exit, isExiting, setExitCode } from './exit.js';
import { installPrintInterrupt, printExitCode, type PrintInterrupt } from './print-interrupt.js';
import { parseNumericFlag } from './utils.js';
import { parseEffortLevel } from '../commands/effort.js';
import { join } from 'path';
import type { AgentConfig } from '../types/runtime.js';
import type { RewindSnapshotStoreInterface } from '../types/sessions.js';
import type { HeadlessResult } from '../types/public-sdk.js';
import { resolveSessionBootstrap } from '../session/resolve.js';
import { runMemoryExtraction } from '../memory-extract.js';
import {
  createRewindSnapshotStore,
  createUnavailableRewindSnapshotStore,
} from '../rewind/snapshot-store.js';
import { createEphemeralRewindEnvironment } from '../rewind/environment.js';
import {
  cleanupDebugLogs,
  createDebugLogger,
  DEFAULT_LOCAL_DATA_RETENTION_DAYS,
  getDebugLogPath,
} from '../debug-log.js';
import { installInkScrollRenderer } from './ink-scroll-renderer.js';
import { installFrameCapture } from './frame-buffer.js';
import { isInkIncrementalRendererPatched } from './ink-patch.js';
import { resolveTuiRendererMode } from './tui-renderer-mode.js';
import { resolvePermissionMode } from '../permission-mode.js';
import { spawn } from 'node:child_process';
import { resolveBookHome } from '../book-home.js';

const SESSION_ROOT = join(resolveBookHome(), 'sessions');
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
/**
 * Every mouse-reporting mode a terminal may have on, not just the ones Book
 * sets. Clear stale modes before enabling the narrow mode Book needs, and
 * clear them all again on exit so a crashed session cannot leak reports into
 * the next shell prompt.
 */
const DISABLE_MOUSE_REPORTING =
  '\x1b[?1000l' + '\x1b[?1002l' + '\x1b[?1003l' + '\x1b[?1006l' + '\x1b[?1015l';
const ENABLE_BUTTON_EVENT_TRACKING = '\x1b[?1002h';
const ENABLE_SGR_MOUSE = '\x1b[?1006h';
/**
 * Alternate scroll translates the wheel into cursor keys while the alternate
 * screen is up. Book handles SGR wheel reports itself, so cursor-key emulation
 * must stay off for the session and is handed back on exit.
 */
const DISABLE_ALTERNATE_SCROLL = '\x1b[?1007l';
const RESTORE_ALTERNATE_SCROLL = '\x1b[?1007h';
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
  /** Injectable so the non-TTY bridge path is testable off win32. */
  bridgeWslTerminal: boolean = shouldBridgeWslTerminal(),
): () => void {
  if (!stdout.isTTY && !bridgeWslTerminal) return () => {};

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    writeTerminalControl(
      stdout,
      DISABLE_MOUSE_REPORTING + RESTORE_ALTERNATE_SCROLL + EXIT_ALT_SCREEN,
    );
    process.off('exit', restore);
  };

  writeTerminalControl(
    stdout,
    ENTER_ALT_SCREEN +
      DISABLE_MOUSE_REPORTING +
      DISABLE_ALTERNATE_SCROLL +
      ENABLE_BUTTON_EVENT_TRACKING +
      ENABLE_SGR_MOUSE,
  );
  process.once('exit', restore);
  return restore;
}

export async function runMainAction(options: Record<string, unknown>): Promise<void> {
  // Declared before the `try` so the print branch's `catch` can still read them:
  // a run cancelled or interrupted before it returned has no `result` to read.
  let printInterrupt: PrintInterrupt | undefined;
  let printSignal: AbortSignal | undefined;
  try {
    const requestedWorkspace = options.workspace as string | undefined;
    // Validated again here rather than trusted from commander: the option parser
    // covers the CLI, this covers every other caller of runMainAction.
    const effortOverride = options.effort
      ? parseEffortLevel(String(options.effort), '--effort')
      : undefined;
    const config = loadConfig(requestedWorkspace, {
      settingsOverridePath: options.settings as string | undefined,
      noSettings: options.settings === false,
      runMigrations: options.settings !== false,
      modelOverride: options.model as string | undefined,
      effortOverride,
      allowMissingApiKey: options.print === undefined && !options.scrollback,
    }) as AgentConfig;
    // Stderr, so it cannot corrupt --output-format json on stdout.
    if (config.modelProviderWarning) console.warn('⚠  ' + config.modelProviderWarning);
    const interactiveMaxTurns = parseNumericFlag(options.maxTurns, '--max-turns', {
      integer: true,
    });
    if (interactiveMaxTurns !== undefined) config.maxTurns = interactiveMaxTurns;
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
      // Repository-declared allow rules and hooks are withheld until the user
      // decides on them; a non-interactive host cannot ask, so it reports and
      // continues.
      for (const notice of collectWithheldProjectNotices({
        workspace: config.workspace,
        settings: config.settings,
        settingsEnabled: options.settings !== false,
      })) {
        console.warn(notice);
      }
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
      let result: HeadlessResult | undefined;
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

        // Once a reader is gone, stderr and a `text` or `json` answer (written once, at the end)
        // are best-effort: `book -p … 2>&1 | head` must not crash the run with an unhandled EPIPE,
        // which also skipped its SessionEnd hooks. `stream-json` writes stdout for the whole run,
        // so a closed stdout there means the host has gone: abort the run rather than keep
        // editing files for no one. A SIGINT or SIGTERM cancels the run the same way, so
        // SessionEnd runs with reason `aborted`, and a second signal exits at once.
        const printFormat = options.outputFormat as 'text' | 'json' | 'stream-json';
        const readerGone = new AbortController();
        printInterrupt = installPrintInterrupt();
        const callerSignal = options.signal as AbortSignal | undefined;
        printSignal = AbortSignal.any(
          [callerSignal, readerGone.signal, printInterrupt.signal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
          ),
        );
        const onClosedPipe = (stream: 'stdout' | 'stderr') => (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EPIPE') throw error;
          if (stream === 'stdout' && printFormat === 'stream-json') readerGone.abort();
        };
        process.stderr.on('error', onClosedPipe('stderr'));
        process.stdout.on('error', onClosedPipe('stdout'));
        result = await runHeadless(config, registry, {
          prompt: typeof options.print === 'string' ? (options.print as string) : undefined,
          inputFormat: options.inputFormat as 'text' | 'stream-json',
          outputFormat: options.outputFormat as 'text' | 'json' | 'stream-json',
          history: bootstrap.history,
          transcript: bootstrap.transcript,
          compactBoundaries: bootstrap.compactBoundaries,
          plan: bootstrap.plan,
          carriedUsage: bootstrap.carriedUsage,
          carriedModels: bootstrap.carriedModels,
          mode,
          signal: printSignal,
          maxTurns: parseNumericFlag(options.maxTurns, '--max-turns', { integer: true }),
          maxBudgetUsd: parseNumericFlag(options.maxBudgetUsd, '--max-budget-usd'),
          verbose: options.verbose as boolean | undefined,
          quiet: options.quiet as boolean | undefined,
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
        printInterrupt?.dispose();
      }
      // Not `exit(1)`: a failed run returns like a successful one and only marks the exit
      // code, so Node exits once the provider's pooled sockets have closed. Exiting while
      // they are still closing aborts inside libuv on Windows, with exit code 127 (#243).
      const code = printExitCode({
        outcome: result?.outcome,
        aborted: printSignal?.aborted === true,
        interruptedBy: printInterrupt?.interruptedBy(),
      });
      if (code !== 0) setExitCode(code);
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
    const extraction = new AbortController();
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
      await installFrameCapture();
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
      // Phase 1b: read idle earlier sessions of this workspace for memories the model
      // missed. Background and best-effort: it never blocks or fails the session, and an exit
      // aborts it; a session it did not finish is read at the next start. It reads through its
      // own store so old sessions are not cached in the TUI's store for the whole session.
      if (sessionStore) {
        void runMemoryExtraction({
          config,
          sessions: new SessionStore(SESSION_ROOT),
          currentSessionId: bootstrap.sessionId,
          permissionMode: mode,
          signal: extraction.signal,
        })
          .then((result) => createDebugLogger('memory').info('extraction', { ...result }))
          .catch((error: unknown) =>
            createDebugLogger('memory').warn('extraction failed', {
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
      await app.waitUntilExit();
    } finally {
      extraction.abort();
      app?.cleanup();
      restoreScreen();
      await mcpHost.dispose();
      ephemeralRewind?.dispose();
    }
  } catch (e) {
    if (isExiting()) throw e;
    console.error(e instanceof Error ? e.message : String(e));
    // A thrown print failure gets the same treatment as a returned one (#243): mark
    // the exit code and let Node exit once its handles close. The TUI still exits at
    // once, since Ink may still hold stdin.
    if (options.print !== undefined) {
      printInterrupt?.dispose();
      const code = printExitCode({
        aborted: printSignal?.aborted === true,
        interruptedBy: printInterrupt?.interruptedBy(),
      });
      if (code !== 0) setExitCode(code);
      return;
    }
    exit(1);
  }
}

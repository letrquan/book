import { render } from 'ink';
import { createElement } from 'react';
import { loadConfig } from '../config.js';
import { runHeadless } from '../headless.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { SessionStore } from '../session/store.js';
import { connectMcpServers } from '../mcp.js';
import { exit } from './exit.js';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentConfig } from '../types.js';

const SESSION_ROOT = join(homedir(), '.book', 'sessions');
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

export function enterAlternateScreen(
  stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'write'> = process.stdout,
): () => void {
  if (!stdout.isTTY) return () => {};

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdout.write(EXIT_ALT_SCREEN);
    process.off('exit', restore);
  };

  stdout.write(ENTER_ALT_SCREEN);
  process.once('exit', restore);
  return restore;
}

export async function runMainAction(options: Record<string, unknown>): Promise<void> {
  try {
    const config = loadConfig(options.workspace as string | undefined, {
      settingsOverridePath: options.settings as string | undefined,
      noSettings: options.settings === false,
    }) as AgentConfig;
    if (options.model) config.model = options.model as string;
    if (options.maxTurns) config.maxTurns = parseInt(options.maxTurns as string, 10);

    // Headless / print mode.
    if (options.print !== undefined) {
      // Connect MCP servers and merge their tools into the registry.
      const mcp = await connectMcpServers(config.workspace);
      const registry = createDefaultRegistry();
      if (mcp.tools.length > 0) {
        registry.registerAll(mcp.tools);
      }

      const rawMode = ((options.permissionMode as string) ?? 'default') as string;
      const mode = (rawMode === 'acceptEdits' ? 'accept-edits' : rawMode) as
        | 'default'
        | 'accept-edits'
        | 'plan'
        | 'auto'
        | 'dontAsk'
        | 'bypassPermissions';

      const sessionStore = (options.sessionPersistence as boolean)
        ? new SessionStore(SESSION_ROOT)
        : undefined;
      // Purge old sessions at startup.
      sessionStore?.cleanup(30);

      // Resolve history from a resumed session.
      let history: import('../types.js').Message[] = [];
      let sessionId = options.sessionId as string | undefined;
      let sessionName = options.name as string | undefined;
      if (sessionStore) {
        if (options.resume) {
          const meta =
            sessionStore.findByName(options.resume as string) ??
            sessionStore.findById(options.resume as string);
          if (meta) {
            const loaded = sessionStore.load(meta.id);
            history = loaded.history;
            if (!options.forkSession) sessionId = meta.id;
          } else {
            console.error(`Session not found: ${options.resume}`);
            exit(1);
          }
        } else if ((options.continue as boolean) && !history.length) {
          const meta = sessionStore.mostRecentInCwd(config.workspace);
          if (meta) {
            const loaded = sessionStore.load(meta.id);
            history = loaded.history;
            if (!options.forkSession) sessionId = meta.id;
          }
        }
      }

      await runHeadless(config, registry, {
        prompt: typeof options.print === 'string' ? (options.print as string) : undefined,
        inputFormat: options.inputFormat as 'text' | 'stream-json',
        outputFormat: options.outputFormat as 'text' | 'json' | 'stream-json',
        history,
        mode,
        maxTurns: options.maxTurns ? parseInt(options.maxTurns as string, 10) : undefined,
        maxBudgetUsd: options.maxBudgetUsd
          ? parseFloat(options.maxBudgetUsd as string)
          : undefined,
        verbose: options.verbose as boolean | undefined,
        jsonSchema: options.jsonSchema
          ? JSON.parse(options.jsonSchema as string)
          : undefined,
        sessionStore,
        sessionId,
        sessionName,
        forkSession: options.forkSession as boolean | undefined,
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
      | 'default'
      | 'accept-edits'
      | 'plan'
      | 'auto'
      | 'dontAsk'
      | 'bypassPermissions';
    if (options.scrollback) {
      const { runScrollbackSession } = await import('./scrollback.js');
      await runScrollbackSession(config, { mode });
      return;
    }

    const { App } = await import('../tui/app.js');
    let app: ReturnType<typeof render> | undefined;
    try {
      app = render(createElement(App, { config }));
      await app.waitUntilExit();
    } finally {
      app?.cleanup();
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    exit(1);
  }
}

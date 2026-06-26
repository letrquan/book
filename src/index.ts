#!/usr/bin/env node
import { program } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { homedir } from 'os';
import { join } from 'path';
import { App } from './tui/app.js';
import { loadConfig } from './config.js';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import { SessionStore } from './session/store.js';

const SESSION_ROOT = join(homedir(), '.book', 'sessions');

program
  .name('book')
  .description('AI coding agent with rich TUI')
  .version('0.1.0')
  .option('-w, --workspace <path>', 'Workspace root directory', process.cwd())
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --print [prompt]', 'Print mode (non-interactive). Reads prompt from the flag or stdin.')
  .option('--output-format <format>', 'text | json | stream-json (print mode)', 'text')
  .option('--input-format <format>', 'text | stream-json (print mode)', 'text')
  .option('--max-turns <n>', 'Max agent turns (print mode)')
  .option('--max-budget-usd <amount>', 'Max USD spend (print mode)')
  .option('--permission-mode <mode>', 'default | acceptEdits | plan | auto | dontAsk | bypassPermissions')
  .option('--verbose', 'Full turn-by-turn output')
  .option('--json-schema <schema>', 'Return validated JSON matching a JSON Schema (print mode)')
  .option('-r, --resume <id|name>', 'Resume a session by id or name')
  .option('-c, --continue', 'Resume the most recent session in this directory')
  .option('--session-id <uuid>', 'Use a specific session id')
  .option('-n, --name <name>', 'Set a display name for the session')
  .option('--no-session-persistence', 'Do not save the session to disk')
  .option('--fork-session', 'On resume, create a new session id instead of reusing')
  .action(async (options) => {
    try {
      const config = loadConfig(options.workspace);
      if (options.model) config.model = options.model;
      if (options.maxTurns) config.maxTurns = parseInt(options.maxTurns, 10);

      // Headless / print mode.
      if (options.print !== undefined) {
        const rawMode = (options.permissionMode ?? 'default') as string;
        const mode = (rawMode === 'acceptEdits' ? 'accept-edits' : rawMode) as
          | 'default'
          | 'accept-edits'
          | 'plan'
          | 'auto'
          | 'dontAsk'
          | 'bypassPermissions';

        const sessionStore = options.sessionPersistence
          ? new SessionStore(SESSION_ROOT)
          : undefined;
        // Purge old sessions at startup.
        sessionStore?.cleanup(30);

        // Resolve history from a resumed session.
        let history: import('./types.js').Message[] = [];
        let sessionId = options.sessionId;
        let sessionName = options.name;
        if (sessionStore) {
          if (options.resume) {
            const meta =
              sessionStore.findByName(options.resume) ??
              sessionStore.findById(options.resume);
            if (meta) {
              const loaded = sessionStore.load(meta.id);
              history = loaded.history;
              if (!options.forkSession) sessionId = meta.id;
            } else {
              console.error(`Session not found: ${options.resume}`);
              process.exit(1);
            }
          } else if (options.continue && !history.length) {
            const meta = sessionStore.mostRecentInCwd(config.workspace);
            if (meta) {
              const loaded = sessionStore.load(meta.id);
              history = loaded.history;
              if (!options.forkSession) sessionId = meta.id;
            }
          }
        }

        await runHeadless(config, createDefaultRegistry(), {
          prompt: typeof options.print === 'string' ? options.print : undefined,
          inputFormat: options.inputFormat as 'text' | 'stream-json',
          outputFormat: options.outputFormat as 'text' | 'json' | 'stream-json',
          history,
          mode,
          maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : undefined,
          maxBudgetUsd: options.maxBudgetUsd ? parseFloat(options.maxBudgetUsd) : undefined,
          verbose: options.verbose,
          jsonSchema: options.jsonSchema ? JSON.parse(options.jsonSchema) : undefined,
          sessionStore,
          sessionId,
          sessionName,
          forkSession: options.forkSession,
          persistSession: options.sessionPersistence,
        });
        return;
      }

      // Interactive TUI mode.
      const { unmount } = render(createElement(App, { config }));
      void unmount;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

program.parse();

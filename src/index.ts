#!/usr/bin/env node
import { program } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { App } from './tui/app.js';
import { loadConfig } from './config.js';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';

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
  .action(async (options) => {
    try {
      const config = loadConfig(options.workspace);
      if (options.model) config.model = options.model;
      if (options.maxTurns) config.maxTurns = parseInt(options.maxTurns, 10);

      // Headless / print mode.
      if (options.print !== undefined) {
        // Accept either acceptEdits or accept-edits on the CLI; normalize to the kebab form.
        const rawMode = (options.permissionMode ?? 'default') as string;
        const mode = (rawMode === 'acceptEdits' ? 'accept-edits' : rawMode) as
          | 'default'
          | 'accept-edits'
          | 'plan'
          | 'auto'
          | 'dontAsk'
          | 'bypassPermissions';
        await runHeadless(config, createDefaultRegistry(), {
          prompt: typeof options.print === 'string' ? options.print : undefined,
          inputFormat: options.inputFormat as 'text' | 'stream-json',
          outputFormat: options.outputFormat as 'text' | 'json' | 'stream-json',
          history: [],
          mode,
          maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : undefined,
          maxBudgetUsd: options.maxBudgetUsd ? parseFloat(options.maxBudgetUsd) : undefined,
          verbose: options.verbose,
          jsonSchema: options.jsonSchema ? JSON.parse(options.jsonSchema) : undefined,
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

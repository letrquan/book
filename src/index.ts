#!/usr/bin/env node
import { program } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { App } from './tui/app.js';
import { loadConfig } from './config.js';

program
  .name('book')
  .description('AI coding agent with rich TUI')
  .version('0.1.0')
  .option('-w, --workspace <path>', 'Workspace root directory', process.cwd())
  .option('-m, --model <model>', 'Model to use')
  .action((options) => {
    try {
      const config = loadConfig(options.workspace);
      if (options.model) {
        config.model = options.model;
      }

      const { unmount } = render(createElement(App, { config }));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

program.parse();

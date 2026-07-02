#!/usr/bin/env node
import { program } from 'commander';
import { runDoctorCommand } from './cli/doctor.js';
import { runConfigCommand } from './cli/config-cmd.js';
import { runMainAction } from './cli/run.js';

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
  .option('--include-hook-events', 'Emit hook lifecycle events in stream-json output')
  .option('--include-partial-messages', 'Emit partial assistant text deltas in stream-json output')
  .option('--prompt-suggestions', 'Ask model for follow-up prompt suggestions after completion')
  .option('--scrollback', 'Use terminal-native scrollback instead of the full-screen TUI')
  .option('--settings <path>', 'Path to an ad-hoc settings file (overrides all scopes)')
  .option('--no-settings', 'Skip all settings.json layers (use defaults + legacy .bookrc.json)');

// ---- book doctor ----
program
  .command('doctor')
  .description('Diagnose configuration and environment')
  .option('-w, --workspace <path>', 'Workspace root directory', process.cwd())
  .action(async (options) => {
    await runDoctorCommand(options.workspace);
  });

// ---- book config ----
program
  .command('config')
  .description('Read and write settings')
  .option('-w, --workspace <path>', 'Workspace root directory', process.cwd())
  .argument('[action]', 'get <key>, set <key> <value>, or list')
  .argument('[key]', 'Dot-separated key path (e.g. permissions.deny)')
  .argument('[value]', 'Value to set (JSON-parsed)')
  .action(async (action, key, value, options) => {
    await runConfigCommand(options.workspace, action, key, value);
  });

// ---- main (interactive / headless) ----
program.action(async (options) => {
  await runMainAction(options);
});

program.parse();

#!/usr/bin/env node
import './runtime-env.js';
import { program } from 'commander';
import { runDoctorCommand } from './cli/doctor.js';
import { runToolStatsCommand } from './cli/tool-stats.js';
import { runConfigCommand } from './cli/config-cmd.js';
import { runMainAction } from './cli/run.js';
import { getPackageVersion } from './version-info.js';
import { formatSettingsKeyHelp } from './settings-repository.js';

program
  .name('book')
  .description('AI coding agent with rich TUI')
  .version(getPackageVersion())
  .option('-w, --workspace <path>', 'Workspace root directory', process.cwd())
  .option('-m, --model <model>', 'Model to use')
  .option(
    '-p, --print [prompt]',
    'Print mode (non-interactive). Reads prompt from the flag or stdin.',
  )
  .option('--output-format <format>', 'text | json | stream-json (print mode)', 'text')
  .option('--input-format <format>', 'text | stream-json (print mode)', 'text')
  .option('--max-turns <n>', 'Max agent turns (print mode; omit for unlimited)')
  .option('--max-budget-usd <amount>', 'Max USD spend (print mode)')
  .option(
    '--permission-mode <mode>',
    'default | acceptEdits | plan | auto | dontAsk | bypassPermissions (overrides settings.defaultMode)',
  )
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
  .option('--agents <mode>', 'Managed agents: adaptive, manual, off')
  .option('--scrollback', 'Use terminal-native scrollback instead of the full-screen TUI')
  .option('--settings <path>', 'Path to an ad-hoc settings file (overrides all scopes)')
  .option('--no-settings', 'Skip all settings.json layers (use defaults + legacy .bookrc.json)')
  .option(
    '--effort <level>',
    'Thinking effort: low, medium, high, xhigh, max (default: high)',
    'high',
  )
  .option('--provider <type>', 'Provider: anthropic, openai, auto (default: auto-detect)');

// ---- book doctor ----
program
  .command('doctor')
  .description('Diagnose configuration and environment')
  .option('-w, --workspace <path>', 'Workspace root directory', process.cwd())
  .action(async (options: { workspace: string }) => {
    await runDoctorCommand(options.workspace);
  });

// ---- book tool-stats ----
program
  .command('tool-stats')
  .description(
    'Inspect and measure tool use recorded across sessions (fail counts, rates, durations)',
  )
  .option('-w, --workspace <path>', 'Workspace root directory', process.cwd())
  .option('--json', 'Emit the aggregate as JSON')
  .option('--since <days>', 'Only include records from the last N days')
  .option('--all', 'Include the full history, ignoring the retention window')
  .option('--prune', 'Drop records older than the window from disk before reporting')
  .action(
    async (options: {
      workspace: string;
      json?: boolean;
      since?: string;
      all?: boolean;
      prune?: boolean;
    }) => {
      await runToolStatsCommand(options);
    },
  );

// ---- book config ----
program
  .command('config')
  .description('Read and write settings')
  .option('-w, --workspace <path>', 'Workspace root directory', process.cwd())
  .argument('[action]', 'get <key>, set <key> <value>, or list')
  .argument('[key]', 'Dot-separated key path (e.g. permissions.deny)')
  .argument('[value]', 'Value to set (JSON-parsed)')
  .addHelpText('after', `\n${formatSettingsKeyHelp()}`)
  .action(
    async (
      action: string | undefined,
      key: string | undefined,
      value: string | undefined,
      options: { workspace: string },
    ) => {
      const rootSettings = program.opts().settings as string | false | undefined;
      await runConfigCommand(options.workspace, action, key, value, {
        settingsOverridePath: typeof rootSettings === 'string' ? rootSettings : undefined,
        noSettings: rootSettings === false,
      });
    },
  );

// ---- main (interactive / headless) ----
program.action(async (options: Record<string, unknown>) => {
  await runMainAction(options);
});

program.parse();

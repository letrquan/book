#!/usr/bin/env node
import './runtime-env.js';
import { InvalidArgumentError, program } from 'commander';
import { EFFORT_LEVELS, isEffortLevel } from './commands/effort.js';
import { runStatusCommand } from './cli/status-cmd.js';
import { exit } from './cli/exit.js';
import { runDoctorCommand } from './cli/doctor.js';
import { runToolStatsCommand } from './cli/tool-stats.js';
import { runConfigCommand } from './cli/config-cmd.js';
import { runTrustCommand } from './cli/trust-cmd.js';
import { runMainAction } from './cli/run.js';
import { getPackageVersion } from './version-info.js';
import { formatSettingsKeyHelp } from './settings-repository.js';
import {
  runMcpAddCommand,
  runMcpGetCommand,
  runMcpListCommand,
  runMcpRemoveCommand,
} from './cli/mcp.js';

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Reject a bad effort level at parse time, where commander can name the option.
 * Reaching the provider with an unchecked level costs a round trip and returns
 * an opaque HTTP 400 for a mistake stated precisely here.
 */
function parseEffortOption(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isEffortLevel(normalized)) {
    throw new InvalidArgumentError(`Valid levels: ${EFFORT_LEVELS.join(', ')}.`);
  }
  return normalized;
}

/**
 * Resolve the workspace a subcommand should act on.
 *
 * The root and every subcommand declare -w/--workspace, and positional option
 * parsing hands each placement to a different command object: `book -w X sub`
 * is parsed by the root, `book sub -w X` by the subcommand, and neither can see
 * the other's value. Defaulting the subcommand option to process.cwd() made an
 * unset one indistinguishable from a deliberate `.`, so a root-side flag was
 * silently overridden and the command acted on the current directory while
 * reporting the flagged path. Leaving the subcommand option undefaulted lets an
 * unset one fall through to the root, which still carries the cwd default.
 */
function resolveWorkspace(workspace: string | undefined): string {
  return workspace ?? (program.opts().workspace as string);
}

program
  .name('book')
  .description('AI coding agent with rich TUI')
  // Root and subcommands both declare -w/--workspace. Without positional
  // option parsing, commander 15 routes a -w that follows a subcommand to the
  // root command, leaving the subcommand on its process.cwd() default: every
  // `book <subcommand> --workspace <path>` silently acted on the wrong
  // directory, and `book config set` wrote settings into the current one.
  // The other placement is handled by resolveWorkspace(); positional parsing
  // also means a root option written after a subcommand name is an error, so
  // any root option a subcommand's action reads must be re-declared on it.
  .enablePositionalOptions()
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
  .option(
    '--harness-workflow <id>',
    'Harness execution workflow: minimal, safe-edit, verify-heavy (requires harness.mode != off; run-scoped)',
  )
  .option('--scrollback', 'Use terminal-native scrollback instead of the full-screen TUI')
  .option('--settings <path>', 'Path to an ad-hoc settings file (overrides all scopes)')
  .option('--no-settings', 'Skip all settings.json layers (use defaults + legacy .bookrc.json)')
  .option(
    '--effort <level>',
    'Thinking effort: low, medium, high, xhigh, max (default: high)',
    parseEffortOption,
    'high',
  )
  .option('--provider <type>', 'Provider: anthropic, openai, auto (default: auto-detect)');

// ---- book doctor ----
program
  .command('doctor')
  .description('Diagnose configuration and environment')
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  // Doctor exists for a configuration that does not work, so it needs the way
  // past one that will not even load. Positional option parsing means a root
  // option written after a subcommand is an error, so it is re-declared here.
  .option('--no-settings', 'Skip all settings.json layers (use defaults + legacy .bookrc.json)')
  .action(async (options: { workspace?: string; settings?: boolean }) => {
    await runDoctorCommand(resolveWorkspace(options.workspace), {
      noSettings: options.settings === false,
    });
  });

// ---- book status ----
program
  .command('status')
  .description('Report what a session is working on and what it has spent (no credentials needed)')
  .argument('[session]', 'Session id or name (defaults to the most recent in this workspace)')
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  .option('--json', 'Emit the status as JSON')
  .action((session: string | undefined, options: { workspace?: string; json?: boolean }) => {
    const code = runStatusCommand({
      session,
      workspace: resolveWorkspace(options.workspace),
      json: options.json,
    });
    if (code !== 0) exit(code);
  });

// ---- book tool-stats ----
program
  .command('tool-stats')
  .description(
    'Inspect and measure tool use recorded across sessions (fail counts, rates, durations)',
  )
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  .option('--json', 'Emit the aggregate as JSON')
  .option('--since <days>', 'Only include records from the last N days')
  .option('--all', 'Include the full history, ignoring the retention window')
  .option('--prune', 'Drop records older than the window from disk before reporting')
  .action(
    async (options: {
      workspace?: string;
      json?: boolean;
      since?: string;
      all?: boolean;
      prune?: boolean;
    }) => {
      await runToolStatsCommand({ ...options, workspace: resolveWorkspace(options.workspace) });
    },
  );

// ---- book mcp ----
const mcpCommand = program.command('mcp').description('Manage MCP server configurations');

mcpCommand
  .command('list')
  .description('List resolved MCP servers without revealing secret values')
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  .option('--json', 'Emit JSON')
  .action((options: { workspace?: string; json?: boolean }) =>
    runMcpListCommand({ ...options, workspace: resolveWorkspace(options.workspace) }),
  );

mcpCommand
  .command('get')
  .description('Show one resolved MCP server without revealing secret values')
  .argument('<name>', 'Server name')
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  .option('--json', 'Emit JSON')
  .action((name: string, options: { workspace?: string; json?: boolean }) =>
    runMcpGetCommand(name, { ...options, workspace: resolveWorkspace(options.workspace) }),
  );

mcpCommand
  .command('add')
  .description('Add an MCP server (use -- before stdio arguments that start with a dash)')
  .argument('<name>', 'Server name')
  .argument('<command-or-url>', 'Stdio executable or HTTP/SSE URL')
  .argument('[server-args...]', 'Arguments for a stdio server')
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  .option('--scope <scope>', 'user | project', 'user')
  .option('--transport <type>', 'stdio | http | sse')
  .option('-e, --env <KEY=VALUE>', 'Stdio environment entry (repeatable)', collectOption, [])
  .option('-H, --header <KEY=VALUE>', 'HTTP header (repeatable)', collectOption, [])
  .option('--cwd <path>', 'Working directory for a stdio server')
  .option('--force', 'Replace an existing same-scope server')
  .action(
    (
      name: string,
      target: string,
      serverArgs: string[],
      options: {
        workspace?: string;
        scope: 'user' | 'project';
        transport?: 'stdio' | 'http' | 'sse';
        env: string[];
        header: string[];
        cwd?: string;
        force?: boolean;
      },
    ) =>
      runMcpAddCommand(name, target, serverArgs, {
        ...options,
        workspace: resolveWorkspace(options.workspace),
      }),
  );

mcpCommand
  .command('remove')
  .alias('rm')
  .description('Remove an MCP server from its effective scope')
  .argument('<name>', 'Server name')
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  .option('--scope <scope>', 'user | project')
  .action((name: string, options: { workspace?: string; scope?: 'user' | 'project' }) =>
    runMcpRemoveCommand(name, { ...options, workspace: resolveWorkspace(options.workspace) }),
  );

// ---- book trust ----
const trustCommand = program
  .command('trust')
  .description('Record decisions about configuration a repository declared');

trustCommand
  .command('hook')
  .description('Approve or reject a project-declared hook (see `book doctor`)')
  .argument('[fingerprint]', 'Hook fingerprint reported by `book doctor`')
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  .option('--all-pending', 'Apply to every hook currently awaiting a decision')
  .option('--reject', 'Record a refusal instead of an approval')
  .action(
    async (
      fingerprint: string | undefined,
      options: { workspace?: string; allPending?: boolean; reject?: boolean },
    ) => {
      await runTrustCommand('hook', fingerprint, {
        ...options,
        workspace: resolveWorkspace(options.workspace),
      });
    },
  );

trustCommand
  .command('command')
  .description('Approve or reject a project command that substitutes shell into its prompt')
  .argument('[name]', 'Command name, with or without the leading slash')
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  .option('--all-pending', 'Apply to every command currently awaiting a decision')
  .option('--reject', 'Record a refusal instead of an approval')
  .action(
    async (
      name: string | undefined,
      options: { workspace?: string; allPending?: boolean; reject?: boolean },
    ) => {
      await runTrustCommand('command', name, {
        ...options,
        workspace: resolveWorkspace(options.workspace),
      });
    },
  );

trustCommand
  .command('rule')
  .description('Approve or reject a project-declared permissions.allow rule')
  .argument('[rule]', 'Rule text exactly as the project declared it')
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  .option('--all-pending', 'Apply to every rule currently awaiting a decision')
  .option('--reject', 'Record a refusal instead of an approval')
  .action(
    async (
      rule: string | undefined,
      options: { workspace?: string; allPending?: boolean; reject?: boolean },
    ) => {
      await runTrustCommand('rule', rule, {
        ...options,
        workspace: resolveWorkspace(options.workspace),
      });
    },
  );

// ---- book config ----
program
  .command('config')
  .description('Read and write settings')
  .option('-w, --workspace <path>', 'Workspace root directory (defaults to the root -w, then cwd)')
  // Re-declared from the root because this action reads them: positional option
  // parsing rejects a root option written after the subcommand name, so without
  // these `book config get model --settings <path>` fails with "unknown option".
  // Declared in this order so commander leaves `settings` undefined when neither
  // flag is passed, letting an unset one fall through to the root's value.
  .option('--settings <path>', 'Path to an ad-hoc settings file (overrides all scopes)')
  .option('--no-settings', 'Skip all settings.json layers (use defaults + legacy .bookrc.json)')
  // Writes default to the user layer so a setting follows the person, not the
  // directory. The two workspace layers stay reachable, but have to be asked
  // for -- the shortest command is the one that stays consistent everywhere.
  .option('-g, --global', 'Act on user-global settings (<BOOK_HOME>/settings.json) [default]')
  .option('--project', 'Act on checked-in project settings (.book/settings.json)')
  .option('--local', 'Act on gitignored project-local settings (.book/settings.local.json)')
  .argument('[action]', 'get <key>, set <key> <value>, unset <key>, or list')
  .argument('[key]', 'Dot-separated key path (e.g. permissions.deny)')
  .argument('[value]', 'Value to set (JSON-parsed)')
  .addHelpText('after', `\n${formatSettingsKeyHelp()}`)
  .action(
    async (
      action: string | undefined,
      key: string | undefined,
      value: string | undefined,
      options: {
        workspace?: string;
        settings?: string | false;
        global?: boolean;
        project?: boolean;
        local?: boolean;
      },
    ) => {
      const rootSettings = program.opts().settings as string | false | undefined;
      const settings = options.settings ?? rootSettings;
      const selected = (
        [
          ['user', options.global],
          ['project', options.project],
          ['local', options.local],
        ] as const
      ).filter(([, on]) => on === true);
      if (selected.length > 1) {
        console.error(
          'Pass at most one of --global, --project, --local. ' +
            'Writes default to --global; reads without one report the resolved merge.',
        );
        exit(1);
      }
      await runConfigCommand(resolveWorkspace(options.workspace), action, key, value, {
        settingsOverridePath: typeof settings === 'string' ? settings : undefined,
        noSettings: settings === false,
        scope: selected[0]?.[0],
      });
    },
  );

// ---- main (interactive / headless) ----
program.action(async (options: Record<string, unknown>) => {
  await runMainAction(options);
});

program.parse();

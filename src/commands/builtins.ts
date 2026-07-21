import { writeFileSync } from 'fs';
import { join } from 'path';
import type { CommandContext, Message } from '../types.js';
import { buildInitPrompt } from './init-prompt.js';
import {
  buildReviewPrompt,
  buildSecurityReviewPrompt,
  REVIEW_TOOLS,
  SECURITY_REVIEW_TOOLS,
} from './builtins-prompts.js';
import { CommandRegistry, type CommandAlias, type CommandDefinition } from './registry.js';
import { buildReleaseNotesReport, writeFeedbackReport } from '../version-info.js';

export interface BuiltinCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Hide from / autocomplete when empty, but still match when typed exactly. */
  isHidden?: boolean;
}

export interface BuiltinCommandContext {
  workspace: string;
  sessionId: string;
  model: string;
  provider?: string;
  currentTurn: number;
  messages: Message[];
  lastError?: string | null;
}

export type BuiltinCommandEffect =
  | { type: 'legacy'; commandName: string; rawArguments: string }
  | { type: 'send-prompt'; prompt: string; context: CommandContext }
  | { type: 'local-message'; content: string };

export type BuiltinCommandDefinition = CommandDefinition<
  BuiltinCommandContext,
  BuiltinCommandEffect
>;

function legacyCommand(
  name: string,
  description: string,
  options: {
    argumentHint?: string;
    aliases?: CommandAlias[];
    isHidden?: boolean;
  } = {},
): BuiltinCommandDefinition {
  return {
    name,
    description,
    ...options,
    execute: ({ rawArguments }) => ({ type: 'legacy', commandName: name, rawArguments }),
  };
}

function promptEffect(
  name: string,
  description: string,
  prompt: string,
  allowedTools: string[],
): BuiltinCommandEffect {
  return {
    type: 'send-prompt',
    prompt,
    context: {
      command: { name, description, body: prompt, source: 'project' },
      resolvedBody: prompt,
      allowedTools,
    },
  };
}

export const BUILTIN_COMMAND_DEFINITIONS: BuiltinCommandDefinition[] = [
  legacyCommand('clear', 'Start a new conversation', {
    argumentHint: '[previous-name]',
    aliases: [
      { name: 'new', description: 'Start a new conversation', argumentHint: '[previous-name]' },
      {
        name: 'reset',
        description: 'Alias for /clear',
        argumentHint: '[previous-name]',
        isHidden: true,
      },
    ],
  }),
  legacyCommand('resume', 'Resume a saved conversation', {
    argumentHint: '[id|name]',
    aliases: [
      {
        name: 'continue',
        description: 'Alias for /resume',
        argumentHint: '[id|name]',
        isHidden: true,
      },
    ],
  }),
  legacyCommand('compact', 'Summarize older turns', { argumentHint: '[focus instructions]' }),
  legacyCommand('rewind', 'Restore conversation, workspace code, or both'),
  legacyCommand('exit', 'Exit book'),
  legacyCommand('help', 'Toggle help'),
  legacyCommand('task', 'Add a task'),
  legacyCommand('agents', 'List managed agents'),
  legacyCommand('agent', 'Inspect or control a managed agent', {
    argumentHint: '<id>|send <id> <message>|stop <id>|apply <id>',
  }),
  legacyCommand('theme', 'Switch color theme', { argumentHint: '[dark|light|auto|name]' }),
  legacyCommand('model', 'Switch models and manage BYOK providers'),
  legacyCommand('providers', 'Add or remove workspace BYOK providers'),
  legacyCommand('effort', 'Set thinking effort', {
    argumentHint: '[low|medium|high|xhigh|max]',
  }),
  legacyCommand('config', 'Show current configuration'),
  legacyCommand('diff', 'Show git diff'),
  legacyCommand('status', 'Show session status'),
  legacyCommand('memory', 'Manage auto-memory', {
    argumentHint: '[status|inbox|approve|discard|on|off|path]',
  }),
  legacyCommand('permissions', 'Manage permission rules'),
  legacyCommand('cost', 'Show token usage and cost'),
  legacyCommand('skills', 'List available skills'),
  {
    name: 'init',
    description: 'Initialize project with CLAUDE.md',
    execute: (_invocation, context) => {
      const prompt = buildInitPrompt(context.workspace);
      return promptEffect('init', 'Initialize CLAUDE.md', prompt, [
        'Read',
        'Glob',
        'Grep',
        'Write',
      ]);
    },
  },
  legacyCommand('reload-skills', 'Re-scan command and skill directories'),
  {
    name: 'export',
    description: 'Export conversation to file',
    execute: ({ rawArguments }, context) => {
      const filename = rawArguments || 'conversation.txt';
      try {
        const text = context.messages
          .map((message) => `${message.role}:\n${message.content}`)
          .join('\n\n---\n\n');
        const destination = join(context.workspace, filename);
        writeFileSync(destination, text, 'utf-8');
        return {
          type: 'local-message',
          content: `Exported ${context.messages.length} messages to ${destination}`,
        };
      } catch (error) {
        return {
          type: 'local-message',
          content: `✕ export failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },
  legacyCommand('usage', 'Session cost & token usage (alias: /stats)', {
    aliases: [{ name: 'stats', description: 'Alias for /usage', isHidden: true }],
  }),
  legacyCommand('context', 'Show what is filling the context window'),
  {
    name: 'review',
    description: 'Review current git diff (correctness & cleanups)',
    execute: ({ rawArguments }) => {
      const prompt = buildReviewPrompt(rawArguments);
      return promptEffect('review', 'Review current diff', prompt, [...REVIEW_TOOLS]);
    },
  },
  {
    name: 'security-review',
    description: 'Security audit of current git diff',
    execute: ({ rawArguments }) => {
      const prompt = buildSecurityReviewPrompt(rawArguments);
      return promptEffect('security-review', 'Security audit of current diff', prompt, [
        ...SECURITY_REVIEW_TOOLS,
      ]);
    },
  },
  {
    name: 'release-notes',
    description: 'Show installed version + changelog',
    execute: (_invocation, context) => ({
      type: 'local-message',
      content: buildReleaseNotesReport(context.workspace),
    }),
  },
  {
    name: 'feedback',
    description: 'Save a bug-report snapshot to .book/feedback/',
    execute: ({ rawArguments }, context) => {
      const lastUser = [...context.messages].reverse().find((message) => message.role === 'user');
      const result = writeFeedbackReport({
        workspace: context.workspace,
        model: context.model,
        provider: context.provider,
        turn: context.currentTurn,
        messageCount: context.messages.length,
        lastUserPromptPreview: lastUser?.content,
        lastError: context.lastError,
        note: rawArguments || undefined,
      });
      return {
        type: 'local-message',
        content: result.ok
          ? `Saved feedback report to ${result.path}. Review it before sharing.`
          : `✕ feedback failed: ${result.error}`,
      };
    },
  },
];

function metadataForAlias(
  definition: BuiltinCommandDefinition,
  alias: CommandAlias,
): BuiltinCommand {
  return {
    name: alias.name,
    description: alias.description ?? `Alias for /${definition.name}`,
    argumentHint: alias.argumentHint ?? definition.argumentHint,
    isHidden: alias.isHidden,
  };
}

/** Shared metadata consumed by autocomplete, help, and system-prompt generation. */
export const BUILTIN_COMMANDS: BuiltinCommand[] = BUILTIN_COMMAND_DEFINITIONS.flatMap(
  (definition) => [
    {
      name: definition.name,
      description: definition.description,
      argumentHint: definition.argumentHint,
      isHidden: definition.isHidden,
    },
    ...(definition.aliases ?? []).map((alias) => metadataForAlias(definition, alias)),
  ],
);

export const BUILTIN_BY_NAME: Record<string, BuiltinCommand> = Object.fromEntries(
  BUILTIN_COMMANDS.map((command) => [command.name, command]),
);

export function createBuiltinCommandRegistry(): CommandRegistry<
  BuiltinCommandContext,
  BuiltinCommandEffect
> {
  const registry = new CommandRegistry<BuiltinCommandContext, BuiltinCommandEffect>();
  registry.registerAll(BUILTIN_COMMAND_DEFINITIONS);
  return registry;
}

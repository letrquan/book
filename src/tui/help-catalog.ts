import { BUILTIN_COMMAND_DEFINITIONS } from '../commands/builtins.js';

/** One command as /help lists it. */
export interface HelpEntry {
  /** `/clear`, with its visible aliases: `/clear, /new`. */
  name: string;
  argumentHint?: string;
  description: string;
}

export interface HelpGroup {
  title: string;
  entries: HelpEntry[];
}

/**
 * The groups /help sets the built-in commands in, in reading order. A command
 * not named here lands in a trailing "More" group, so a new command still shows
 * up in /help the day it is added; the old hand-written list had fallen behind
 * the registry by five commands.
 */
const GROUPS: ReadonlyArray<{ title: string; names: readonly string[] }> = [
  { title: 'Conversation', names: ['clear', 'resume', 'compact', 'rewind', 'export', 'exit'] },
  { title: 'Model', names: ['model', 'providers', 'effort'] },
  { title: 'Context', names: ['context', 'usage', 'cost', 'status', 'memory'] },
  { title: 'Code', names: ['diff', 'review', 'security-review', 'init'] },
  { title: 'Agents', names: ['agents', 'agent', 'tasks', 'jobs', 'task'] },
  { title: 'Setup', names: ['config', 'permissions', 'skills', 'reload-skills', 'mcp'] },
  { title: 'Book', names: ['help', 'release-notes', 'feedback'] },
];

/** The built-in commands, grouped for /help, with visible aliases folded into each name. */
export function builtinHelpGroups(): HelpGroup[] {
  const visible = BUILTIN_COMMAND_DEFINITIONS.filter((definition) => !definition.isHidden);
  const entryFor = (definition: (typeof visible)[number]): HelpEntry => {
    const aliases = (definition.aliases ?? [])
      .filter((alias) => !alias.isHidden)
      .map((alias) => `/${alias.name}`);
    return {
      name: [`/${definition.name}`, ...aliases].join(', '),
      argumentHint: definition.argumentHint,
      description: definition.description,
    };
  };
  const placed = new Set<string>();
  const groups: HelpGroup[] = [];
  for (const group of GROUPS) {
    const entries = group.names.flatMap((name) => {
      const definition = visible.find((candidate) => candidate.name === name);
      if (!definition) return [];
      placed.add(name);
      return [entryFor(definition)];
    });
    if (entries.length > 0) groups.push({ title: group.title, entries });
  }
  const rest = visible.filter((definition) => !placed.has(definition.name)).map(entryFor);
  if (rest.length > 0) groups.push({ title: 'More', entries: rest });
  return groups;
}

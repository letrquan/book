/**
 * Slash command filtering with categorized display and fuzzy search.
 *
 * Two modes:
 *   - Empty query ("/"): categorized list with recently-used at top
 *   - Typed query ("/com"): Fuse.js fuzzy search with priority ranking
 */

import Fuse from 'fuse.js';
import type { SlashCommand } from '../types.js';
import { BUILTIN_COMMANDS } from './builtins.js';
import { getRecentCommands } from './recent.js';

export interface CommandItem {
  name: string;
  hint: string;
  desc: string;
  /** Category badge: 'recent' | 'builtin' | 'user' | 'project' */
  category: 'recent' | 'builtin' | 'user' | 'project';
}

// ── Fuse.js index (built once per commands array identity via memoization) ──

let _fuseCommands: SlashCommand[] | null = null;
let _fuse: Fuse<{ name: string; desc: string; hint: string }> | null = null;

function getFuse(commands: SlashCommand[]): Fuse<{ name: string; desc: string; hint: string }> {
  // Build a unified list: builtins + custom
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));

  const items: Array<{ name: string; desc: string; hint: string }> = [];

  for (const b of BUILTIN_COMMANDS) {
    if (!b.isHidden) {
      items.push({ name: b.name, desc: b.description, hint: b.argumentHint ?? '' });
    }
  }

  for (const cmd of commands) {
    if (builtinNames.has(cmd.name)) continue;
    if (cmd.isHidden) continue;
    items.push({ name: cmd.name, desc: cmd.description, hint: cmd.argumentHint ?? '' });
  }

  // Only rebuild if commands changed
  if (_fuseCommands === commands && _fuse) return _fuse;

  _fuseCommands = commands;
  _fuse = new Fuse(items, {
    keys: [
      { name: 'name', weight: 3 },
      { name: 'desc', weight: 0.5 },
    ],
    threshold: 0.3,
    location: 0,
    distance: 100,
  });

  return _fuse;
}

// ── Empty query: categorized display ──

export function getCommandsForEmptyQuery(commands: SlashCommand[]): CommandItem[] {
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
  const recentNames = new Set(getRecentCommands());

  const result: CommandItem[] = [];

  // 1. Recently used (sorted by frequency)
  for (const name of getRecentCommands()) {
    const builtin = BUILTIN_COMMANDS.find((b) => b.name === name);
    if (builtin && !builtin.isHidden) {
      result.push({
        name: builtin.name,
        hint: builtin.argumentHint ?? '',
        desc: builtin.description,
        category: 'recent',
      });
    }
  }

  // 2. Built-in commands (alphabetical, excluding recently used and hidden)
  const builtins: CommandItem[] = [];
  for (const b of BUILTIN_COMMANDS) {
    if (b.isHidden || recentNames.has(b.name)) continue;
    builtins.push({
      name: b.name,
      hint: b.argumentHint ?? '',
      desc: b.description,
      category: 'builtin',
    });
  }
  builtins.sort((a, b) => a.name.localeCompare(b.name));
  result.push(...builtins);

  // 3. User commands (alphabetical, excluding recently used)
  const userCmds: CommandItem[] = [];
  for (const cmd of commands) {
    if (builtinNames.has(cmd.name) || recentNames.has(cmd.name) || cmd.isHidden) continue;
    if (cmd.source === 'user') {
      userCmds.push({
        name: cmd.name,
        hint: cmd.argumentHint ?? '',
        desc: cmd.description,
        category: 'user',
      });
    }
  }
  userCmds.sort((a, b) => a.name.localeCompare(b.name));
  result.push(...userCmds);

  // 4. Project commands (alphabetical)
  const projectCmds: CommandItem[] = [];
  for (const cmd of commands) {
    if (builtinNames.has(cmd.name) || recentNames.has(cmd.name) || cmd.isHidden) continue;
    if (cmd.source === 'project') {
      projectCmds.push({
        name: cmd.name,
        hint: cmd.argumentHint ?? '',
        desc: cmd.description,
        category: 'project',
      });
    }
  }
  projectCmds.sort((a, b) => a.name.localeCompare(b.name));
  result.push(...projectCmds);

  return result;
}

// ── Typed query: Fuse.js fuzzy search with priority ranking ──

export function getCommandsForQuery(commands: SlashCommand[], query: string): CommandItem[] {
  const fuse = getFuse(commands);
  const q = query.toLowerCase().trim();
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));

  const searchResults = fuse.search(q);

  // Build a lookup for custom command → source
  const customSource = new Map<string, 'user' | 'project'>();
  for (const cmd of commands) {
    if (!builtinNames.has(cmd.name)) {
      customSource.set(cmd.name, cmd.source);
    }
  }

  // Score each result: 0 = exact name, 1 = prefix name, 2 = fuzzy
  const scored = searchResults.map((r) => {
    const name = r.item.name.toLowerCase();
    let priority: number;
    if (name === q) {
      priority = 0;
    } else if (name.startsWith(q)) {
      priority = 1;
    } else {
      priority = 2;
    }

    const isBuiltin = builtinNames.has(r.item.name);
    const category: CommandItem['category'] = isBuiltin
      ? 'builtin'
      : customSource.get(r.item.name) === 'project'
        ? 'project'
        : 'user';

    return {
      name: r.item.name,
      hint: r.item.hint,
      desc: r.item.desc,
      category,
      priority,
    };
  });

  // Sort: priority first, then alphabetically
  scored.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });

  return scored.map(({ priority, ...item }) => item);
}

import { describe, expect, it } from 'vitest';
import { displayWidth } from './components/word-wrap.js';
import {
  ACTIVITY_PHRASE_LISTS,
  MAX_PHRASE_WIDTH,
  REASONING_PHASES,
  toolActivityText,
} from './working-activity.js';

const ALL_PHRASES = ACTIVITY_PHRASE_LISTS.flat();

describe('activity phrases', () => {
  it('keeps every phrase inside the one-row budget', () => {
    // A phrase is the frame; the target inside it is the fact. Anything wider
    // than the budget spends the row on the joke and truncates the filename.
    const overBudget = ALL_PHRASES.filter((phrase) => displayWidth(phrase) > MAX_PHRASE_WIDTH);
    expect(overBudget).toEqual([]);
  });

  it('reads as a clause, not a sentence', () => {
    for (const phrase of ALL_PHRASES) {
      expect(phrase).toBe(phrase.trim());
      expect(phrase.slice(0, 1)).toBe(phrase.slice(0, 1).toUpperCase());
      expect(phrase.endsWith('.')).toBe(false);
    }
  });

  it('never repeats a line within one list', () => {
    for (const list of ACTIVITY_PHRASE_LISTS) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('carries enough reasoning phases that a long turn does not loop quickly', () => {
    // One phase every three seconds, so this many is the cycle length in turns
    // of three seconds — long enough that a minute of thinking never repeats.
    expect(REASONING_PHASES.length).toBeGreaterThanOrEqual(24);
    expect(new Set(REASONING_PHASES).size).toBe(REASONING_PHASES.length);
  });
});

describe('toolActivityText', () => {
  it('names the file an ApplyPatch envelope touches', () => {
    const text = toolActivityText({
      id: 'patch-1',
      name: 'ApplyPatch',
      arguments: {
        patch: ['*** Begin Patch', '*** Update File: src/tui/app.tsx', '*** End Patch'].join('\n'),
      },
    });

    expect(text).toContain('src/tui/app.tsx');
    expect(text).not.toContain('workspace files');
  });

  it('describes managed-agent and tool-discovery work instead of falling through', () => {
    const spawn = toolActivityText({
      id: 'spawn-1',
      name: 'AgentSpawn',
      arguments: { agent: 'explorer', description: 'map the trust store', prompt: 'go' },
    });
    expect(spawn).toContain('map the trust store');
    expect(spawn).not.toContain('agent spawn');

    const search = toolActivityText({
      id: 'search-1',
      name: 'ToolSearch',
      arguments: { query: 'read session history' },
    });
    expect(search).toContain('read session history');
    expect(search).not.toContain('tool search');
  });

  it('drops a dangling colon when the call carries no target', () => {
    const spawn = toolActivityText({ id: 'spawn-2', name: 'AgentSpawn', arguments: {} });
    expect(spawn.endsWith(':')).toBe(false);
  });

  it('never labels published evidence with its kind enum', () => {
    const described = toolActivityText({
      id: 'ev-1',
      name: 'EvidencePublish',
      arguments: { kind: 'finding', summary: 'fail-open on trust load', confidence: 0.8 },
    });
    expect(described).toContain('fail-open on trust load');

    // No summary: `getPrimaryArg` would fall through to the first string key
    // and hand back `blocker`, naming a category rather than the finding. The
    // phrase stands alone instead.
    const bare = toolActivityText({
      id: 'ev-2',
      name: 'EvidencePublish',
      arguments: { kind: 'blocker', confidence: 0.2 },
    });
    expect(bare).not.toContain('blocker');
    expect(bare.endsWith(':')).toBe(false);
  });

  it('still explains an unknown tool by name', () => {
    const text = toolActivityText({ id: 'x-1', name: 'FaxMachine', arguments: {} });
    expect(text).toContain('fax machine');
  });
});

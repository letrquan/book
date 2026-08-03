import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../settings.js';
import { SessionRuntime } from '../session/runtime.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolContext } from '../types/tools.js';
import { skillsTool } from './skills-tool.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-skill-tool-'));
  const skillDir = join(workspace, '.book', 'skills', 'review');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    ['---', 'name: review', 'description: Review changes', '---', 'Review carefully.'].join('\n'),
  );
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function context(activation: 'auto' | 'manual' | 'off'): ToolContext {
  const runtime = new SessionRuntime();
  const skills = { enabled: true, overrides: { review: activation }, execution: {} };
  runtime.skills(workspace, skills).beginRun('$review');
  runtime.skills(workspace, skills).grantConsent('review');
  return {
    workspaceRoot: workspace,
    env: {},
    runtime,
    agentConfig: {
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        skills,
      },
    } as unknown as AgentConfig,
  };
}

describe('InvokeSkill activation', () => {
  it('allows explicit invocation of a manual skill', async () => {
    const result = await skillsTool[0]!.execute({ skill: 'review' }, context('manual'));
    expect(result.status).toBe('success');
    expect(result.content).toContain('Activated skill "review"');
    expect(result.content).not.toContain('Review carefully.');
  });

  it('blocks disabled skills', async () => {
    const result = await skillsTool[0]!.execute({ skill: 'review' }, context('off'));
    expect(result.status).toBe('blocked');
    expect(result.structuredError?.code).toBe('skill_disabled');
  });

  it('records structured resource failures without returning resource content', async () => {
    const resourceDir = join(workspace, '.book', 'skills', 'review', 'references');
    const resourcePath = join(resourceDir, 'checklist.md');
    mkdirSync(resourceDir, { recursive: true });
    writeFileSync(resourcePath, 'check every edge');
    const ctx = context('auto');
    await skillsTool[0]!.execute({ skill: 'review' }, ctx);
    unlinkSync(resourcePath);

    const result = await skillsTool[1]!.execute(
      { skill: 'review', path: 'references/checklist.md' },
      ctx,
    );
    expect(result.status).toBe('error');
    expect(result.structuredError?.code).toBe('skill_resource_unreadable');
    expect(ctx.runtime?.inspectSkills()?.events.at(-1)?.type).toBe('skill_resource_blocked');
  });
});

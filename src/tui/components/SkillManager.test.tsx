import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { Skill } from '../../skills.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { SkillManager } from './SkillManager.js';

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'project:book:/workspace/.book/skills/code-review/SKILL.md',
    version: 'unversioned',
    descriptorDigest: 'descriptor',
    resourceDigest: 'resources',
    name: 'code-review',
    description: 'Review a change for correctness risks',
    whenToUse: 'When the user asks for review',
    metadata: {},
    allowedTools: ['Read', 'Grep'],
    lifetime: 'run',
    path: '/workspace/.book/skills/code-review/SKILL.md',
    rootPath: '/workspace/.book/skills/code-review',
    source: 'project',
    rootKind: 'book',
    activation: 'auto',
    execution: 'inherit',
    invocationCount: 0,
    entryByteSize: 0,
    entryMtimeMs: 0,
    resources: [],
    issues: [],
    valid: true,
    shadowed: [],
    ...overrides,
  };
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function renderManager(overrides: Partial<React.ComponentProps<typeof SkillManager>> = {}) {
  const onChangeActivation = vi.fn(() => ({ ok: true }));
  const onChangeExecution = vi.fn(() => ({ ok: true }));
  const onChangeEnabled = vi.fn(() => ({ ok: true }));
  const onUse = vi.fn();
  const onReload = vi.fn();
  const onCancel = vi.fn();
  const skills = [
    skill(),
    skill({
      id: 'project:book:/workspace/.book/skills/deploy/SKILL.md',
      name: 'deploy',
      description: 'Deploy the app',
      activation: 'manual',
      path: '/workspace/.book/skills/deploy/SKILL.md',
      rootPath: '/workspace/.book/skills/deploy',
    }),
  ];
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <SkillManager
        skills={skills}
        onChangeActivation={onChangeActivation}
        onChangeExecution={onChangeExecution}
        onChangeEnabled={onChangeEnabled}
        onUse={onUse}
        onReload={onReload}
        onCancel={onCancel}
        {...overrides}
      />
    </ThemeContext.Provider>,
  );
  return {
    view,
    onChangeActivation,
    onChangeExecution,
    onChangeEnabled,
    onUse,
    onReload,
    onCancel,
    skills,
  };
}

async function write(view: ReturnType<typeof render>, value: string) {
  view.stdin.write(value);
  await wait(20);
}

afterEach(cleanup);

describe('SkillManager', () => {
  it('shows skill scope, activation, trigger, and path', () => {
    const { view } = renderManager();
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('Manage skills');
    expect(frame).toContain('code-review');
    expect(frame).toContain('auto');
    expect(frame).toContain('project');
    expect(frame).toContain('Trigger: When the user asks for review');
    expect(frame).toContain('/workspace/.book/skills/code-review/SKILL.md');
  });

  it('shows active state and package diagnostics without exposing the body', () => {
    const detailed = skill({
      compatibility: 'Requires git',
      resources: [
        { relativePath: 'references/checklist.md', byteSize: 12, mtimeMs: 1, digest: 'digest' },
      ],
      shadowed: [
        {
          path: '/workspace/.agents/skills/code-review/SKILL.md',
          source: 'project',
          rootKind: 'agents',
        },
      ],
    });
    const { view } = renderManager({ skills: [detailed], activeSkillNames: ['code-review'] });
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('active');
    expect(frame).toContain('Review a change for correctness risks');
    expect(frame).toContain('Compatibility: Requires git');
    expect(frame).toContain('Resource: references/checklist.md');
    expect(frame).toContain('Shadows: /workspace/.agents/skills/code-review/SKILL.md');
  });

  it('cycles visibility with Space', async () => {
    const { view, onChangeActivation } = renderManager();
    await write(view, ' ');
    expect(onChangeActivation).toHaveBeenCalledWith('code-review', 'name-only');
  });

  it('cycles consent policy with E', async () => {
    const { view, onChangeExecution } = renderManager();
    await write(view, 'e');
    expect(onChangeExecution).toHaveBeenCalledWith('code-review', 'ask');
  });

  it('toggles the global skill switch with G', async () => {
    const { view, onChangeEnabled } = renderManager();
    await write(view, 'g');
    expect(onChangeEnabled).toHaveBeenCalledWith(false);
  });

  it('selects a manual skill for explicit use', async () => {
    const { view, onUse, skills } = renderManager();
    await write(view, '\x1b[B');
    await write(view, '\r');
    expect(onUse).toHaveBeenCalledWith(skills[1]);
  });

  it('blocks explicit use while a skill is off', async () => {
    const { view, onUse } = renderManager({ skills: [skill({ activation: 'off' })] });
    await write(view, '\r');
    expect(onUse).not.toHaveBeenCalled();
    expect(stripAnsi(view.lastFrame())).toContain('Change its activation or consent policy');
  });

  it('reloads and closes from keyboard shortcuts', async () => {
    const { view, onReload, onCancel } = renderManager();
    await write(view, 'r');
    await write(view, '\x1b');
    expect(onReload).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('filters the catalog in search mode', async () => {
    const { view } = renderManager();
    await write(view, '/');
    await write(view, 'deploy');
    expect(stripAnsi(view.lastFrame())).toContain('1 matching "deploy"');
    expect(stripAnsi(view.lastFrame())).not.toContain('code-review');
  });

  it('fits narrow terminals', () => {
    const { view } = renderManager({ terminalWidth: 42 });
    const lines = stripAnsi(view.lastFrame()).split('\n');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(42);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { BUILTIN_AGENTS } from '../../agents/profiles.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { AgentProfilePicker } from './AgentProfilePicker.js';

afterEach(cleanup);

describe('AgentProfilePicker', () => {
  it('shows inherited and configured models and selects a profile', () => {
    const onSelect = vi.fn();
    const onReset = vi.fn();
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AgentProfilePicker
          profiles={BUILTIN_AGENTS}
          parentModel="parent/model"
          configuredModels={{ explorer: '9router/qc/qwen3.7-max' }}
          onSelect={onSelect}
          onReset={onReset}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('9router/qc/qwen3.7-max');
    expect(frame).toContain('parent/model (inherit)');
    view.stdin.write('\r');
    expect(onSelect).toHaveBeenCalledWith('explorer');
    view.stdin.write('r');
    expect(onReset).toHaveBeenCalledWith('explorer');
  });

  it('shows the parent model when an explicit inherit bypasses definition frontmatter', () => {
    const custom = { ...BUILTIN_AGENTS[0], name: 'custom', model: 'definition/model' };
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AgentProfilePicker
          profiles={[custom]}
          parentModel="parent/model"
          configuredModels={{ custom: 'inherit' }}
          onSelect={() => {}}
          onReset={() => {}}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    expect(view.lastFrame()).toContain('parent/model (inherit)');
    expect(view.lastFrame()).not.toContain('definition/model');
  });
});

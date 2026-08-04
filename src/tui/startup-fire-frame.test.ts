import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME } from '../types/theme.js';
import { composeStartupFireFrame } from './startup-fire-frame.js';
import { StartupFireSimulation, startupFireStepOptions } from './startup-fire.js';

function frameText(rows: ReturnType<typeof composeStartupFireFrame>['rows']): string {
  return rows.map((runs) => runs.map((run) => run.text).join('')).join('\n');
}

describe('composeStartupFireFrame', () => {
  it('composes stable full-width rows from a deterministic heat field', () => {
    const simulation = new StartupFireSimulation(40, 24, 101);
    for (let tick = 0; tick < 20; tick++) simulation.step(startupFireStepOptions(tick));

    const first = composeStartupFireFrame(simulation, 20, 12, DEFAULT_THEME);
    const second = composeStartupFireFrame(simulation, 20, 12, DEFAULT_THEME);

    expect(first).toEqual(second);
    expect(first.phase).toBe('inferno');
    expect(first.rows).toHaveLength(12);
    expect(
      first.rows.every((runs) => runs.reduce((sum, run) => sum + run.text.length, 0) === 40),
    ).toBe(true);
  });

  it('reveals BOOK, settles into the welcome copy, and reaches awakened state', () => {
    const simulation = new StartupFireSimulation(80, 40, 202);

    const reveal = frameText(composeStartupFireFrame(simulation, 38, 20, DEFAULT_THEME).rows);
    const ashes = frameText(composeStartupFireFrame(simulation, 48, 20, DEFAULT_THEME).rows);
    const awakened = composeStartupFireFrame(simulation, 55, 20, DEFAULT_THEME);
    const awakenedText = frameText(awakened.rows);

    expect(reveal).toContain('WHAT SURVIVES BECOMES KNOWLEDGE');
    expect(ashes).toContain('Your coding workspace, indexed.');
    expect(awakened.phase).toBe('awakened');
    expect(awakenedText).toContain('AGENT AWAKENED  ✦');
    expect(awakenedText).not.toContain('Esc skip');
  });

  it('handles a one-row terminal without indexing outside the frame', () => {
    const simulation = new StartupFireSimulation(8, 2, 303);

    const frame = composeStartupFireFrame(simulation, 0, 1, DEFAULT_THEME);

    expect(frame.rows).toHaveLength(1);
    expect(frame.rows[0].reduce((sum, run) => sum + run.text.length, 0)).toBe(8);
  });
});

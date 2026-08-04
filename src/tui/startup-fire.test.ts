import { describe, expect, it } from 'vitest';
import {
  createBookRuneMask,
  StartupFireSimulation,
  startupFireStepOptions,
} from './startup-fire.js';

function advance(simulation: StartupFireSimulation, ticks: number): void {
  for (let tick = 0; tick < ticks; tick++) {
    simulation.step(startupFireStepOptions(tick));
  }
}

describe('StartupFireSimulation', () => {
  it('produces identical heat fields for the same seed and steps', () => {
    const first = new StartupFireSimulation(32, 24, 12345);
    const second = new StartupFireSimulation(32, 24, 12345);

    advance(first, 18);
    advance(second, 18);

    expect(first.heat).toEqual(second.heat);
    expect(first.heat.some((value) => value > 0)).toBe(true);
  });

  it('keeps every protected BOOK cell cold while heating its corona', () => {
    const simulation = new StartupFireSimulation(48, 30, 77);
    advance(simulation, 20);
    const rune = createBookRuneMask(simulation.width, simulation.pixelHeight);

    simulation.step({ ...startupFireStepOptions(25), protectedMask: rune.mask });

    const protectedHeat = Array.from(simulation.heat).filter((_, index) => rune.mask[index]);
    expect(protectedHeat.length).toBeGreaterThan(0);
    expect(protectedHeat.every((value) => value === 0)).toBe(true);
    expect(simulation.heat.some((value, index) => !rune.mask[index] && value >= 190)).toBe(true);
  });

  it('resamples its heat field safely when the terminal is resized', () => {
    const simulation = new StartupFireSimulation(12, 10, 9);
    advance(simulation, 8);

    simulation.resize(7, 6);

    expect(simulation.width).toBe(7);
    expect(simulation.pixelHeight).toBe(6);
    expect(simulation.heat).toHaveLength(42);
    expect(simulation.heat.some((value) => value > 0)).toBe(true);
  });
});

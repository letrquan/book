import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { AgentManager } from './manager.js';
import { AgentStore } from './store.js';

/**
 * What one foreground delegation costs beyond the sidekick's own model time.
 *
 * A lead/sidekick pairing only pays for itself if the handoff is cheap relative
 * to the work handed off. Vendors publish cost savings for the pattern and no
 * latency at all, so this measures the half that decides whether the split is
 * usable interactively: hold the child's run time fixed and injected, and every
 * millisecond left over is harness — admission checks, profile resolution,
 * record persistence, the wait plumbing, and completion acknowledgement.
 *
 * The assertion is a ceiling, not a target. It exists so that a change which
 * quietly makes delegation an order of magnitude more expensive fails here
 * rather than in someone's transcript.
 *
 * The ceilings are absolute *and* relative. Absolute alone measures the runner
 * rather than the harness: a Windows CI job once did its ordinary file work 20-60x
 * slower than usual for a few seconds while the child's timer still fired on time,
 * so the stall guard below saw nothing and a 596ms best sample failed against a
 * 200ms ceiling. The relative half is a probe of the same kind of work the
 * harness's own store does, timed on the same cycle, so a machine doing that work
 * slowly raises its own ceiling — while a harness that grew an order of magnitude
 * on a machine running at normal speed still fails.
 */

const tempRoots: string[] = [];
/**
 * No lock back-off and no fsync. Every persisted write in a delegation fsyncs
 * its lock, its temp file and the directory, and what that costs is the disk's
 * business, not the harness's: ~10ms on the ubuntu runners, ~20ms on the
 * Windows runners, and ~100ms on a laptop SSD, which put the 200ms median
 * ceiling below the floor of a machine that was doing nothing wrong. With
 * fsync stubbed the number left is the harness alone, which is what the
 * ceilings below are about.
 */
const UNCONTENDED = {
  writerOptions: { sleep: () => {}, fs: { fsyncSync: () => {} } },
} as const;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'book-delegation-latency-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

/** Roughly a persisted agent record's size, so a probe writes about as much as the store does. */
const PROBE_PAYLOAD = {
  id: 'probe-agent',
  status: 'running',
  output: 'delegation-latency-probe-'.repeat(32),
  metadata: { model: 'probe', profile: 'explorer', rootRunId: 'probe-root', parentRunId: null },
} as const;

const PROBE_ITERATIONS = 20;

/**
 * The machine's current speed at doing what the harness's store does: serialize a ~1KB record,
 * stage it, rename it over the target, read it back, parse it. Returns the wall time in ms.
 *
 * The ceilings need a yardstick, and the machine's timer is the wrong one — the Windows CI job that
 * failed #367 fired its timers on time while its file work ran 20-60x slow. This work is the same
 * shape as the harness's, so a probe that is slow says the machine is slow at exactly the thing
 * the overhead is made of, and the ceiling moves with it. The probe does not fsync for the reason
 * `UNCONTENDED` does not: this is about the machine, not the disk's honesty.
 */
function measureProbeMs(): number {
  const root = mkdtempSync(join(tmpdir(), 'book-delegation-probe-'));
  const staging = join(root, 'record.json.staging');
  const target = join(root, 'record.json');
  const startedAt = Date.now();
  try {
    for (let index = 0; index < PROBE_ITERATIONS; index += 1) {
      writeFileSync(staging, JSON.stringify({ ...PROBE_PAYLOAD, index }));
      renameSync(staging, target);
      JSON.parse(readFileSync(target, 'utf8'));
    }
    return Date.now() - startedAt;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Wall-clock breakdown of a single spawn -> run -> wait -> acknowledge cycle. */
async function measureRoundTrip(childRunMs: number): Promise<{
  roundTripMs: number;
  overheadMs: number;
  /** How late the child's own timer fired: the machine's stall, measured on the same cycle. */
  stallMs: number;
}> {
  const root = tempRoot();
  const bookHome = tempRoot();
  vi.stubEnv('BOOK_HOME', bookHome);
  const config = defaultConfig({ workspace: root });
  config.settings.agents.persist = true;
  const manager = new AgentManager(config, [], {
    findGitRoot: async () => undefined,
    createStore: (repoHash, requestedRoot, enabled) =>
      new AgentStore(repoHash, requestedRoot, enabled, UNCONTENDED),
    // Stands in for the sidekick's model turn. Fixed and known, so it subtracts
    // cleanly and what remains is attributable to the harness alone.
    runLoop: async (_childConfig, _registry, _prompt, history) => {
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, childRunMs));
      stallMs = Math.max(0, Date.now() - startedAt - childRunMs);
      return history;
    },
  });
  let stallMs = 0;

  try {
    const startedAt = Date.now();
    const record = await manager.spawn({
      agent: 'explorer',
      prompt: 'Measure the delegation round trip.',
      parentToolCallId: 'probe-call',
    });
    const completed = await manager.wait(record.id, 30_000);
    if (['completed', 'failed', 'stopped', 'interrupted'].includes(completed.status)) {
      await manager.acknowledgeCompletion(`${completed.id}:${completed.completionSequence ?? 0}`);
    }
    const roundTripMs = Date.now() - startedAt;
    return { roundTripMs, overheadMs: Math.max(0, roundTripMs - childRunMs), stallMs };
  } finally {
    manager.dispose();
  }
}

/**
 * The absolute ceiling the best sample must clear, before the probe's say. The harness's own cost is
 * what is left when the machine is not stalling, and a stall can only add to a sample, so the best of
 * five is the measurement and the median is reported beside it. The GitHub Windows runners stall for
 * whole seconds at a time -- medians of 234ms and 610ms on days when the same code measured 7-37ms
 * everywhere else, three red runs in two days -- so there the ceiling is 2.5x; the Ubuntu cells of the
 * same matrix keep the tight one, which is where a regression is caught. A machine doing its ordinary
 * file work slowly raises this further, which is what #367 was about.
 */
function overheadCeilingMs(childRunMs: number): number {
  const windowsCi = process.platform === 'win32' && Boolean(process.env.CI);
  return windowsCi ? childRunMs * 2.5 : childRunMs;
}

/**
 * A machine that cannot fire a 200ms timer within this much of its time is
 * not measuring the harness; it is measuring itself. The GitHub Windows runner
 * did that for a whole run once -- every one of five samples 529-667ms with
 * the timer itself 300ms late -- and no ceiling survives a runner that stalls
 * for the entire test. The stall is measured on the same cycle as the
 * overhead, so the guard cannot excuse a slow harness on a fast machine.
 */
const STALL_TOLERANCE_MS = 100;

/**
 * How many probe-milliseconds the harness may cost before the machine is the suspect.
 *
 * Bounded from both sides by five quiet runs of the measurement on a Windows dev box: overheads of
 * 74-147ms at probes of 25-43ms, the best sample (the measurement — a stall can only add to a cycle)
 * landing at 74-89ms against a ~30ms probe. The lower bound is that a healthy best sample has to sit
 * at least 5x under the ceiling, which wants 15 at a 30ms probe. The upper bound is that an order
 * of magnitude of harness on a machine at normal speed still has to fail: 10 x 74ms is 740ms, which
 * a ceiling of `RATIO x 30ms` must stay under, so the ratio cannot pass ~24. 20 is the middle of
 * that window, and it costs nothing on a machine whose probe is small enough for the absolute
 * ceilings to still be the binding ones (200ms locally, 500ms on the Windows CI cells).
 */
const PROBE_CEILING_RATIO = 20;

/**
 * One cycle's numbers: what the delegation cost, what the machine was doing to the child's own
 * timer while it ran, and what the machine's file work cost around it.
 */
export interface DelegationSample {
  overheadMs: number;
  /** How late the child's own timer fired: the machine's stall, measured on the same cycle. */
  stallMs: number;
  /** The same-cycle cost of `measureProbeMs()`: this machine's speed, at this moment. */
  probeMs: number;
}

/** The absolute half of the ceilings, so the judge can be exercised without measuring anything. */
export interface DelegationCeilings {
  /** Every sample, net of its own stall, must clear this. */
  worstCeilingMs: number;
  /** The best sample, net of its own stall, must clear this. */
  bestCeilingMs: number;
}

/** Net of the machine's own lateness, so what is left is the handoff. */
function netOverheadMs(sample: DelegationSample): number {
  return Math.max(0, sample.overheadMs - sample.stallMs);
}

/**
 * The ceiling one sample is judged against, and which half of it won. Keeping both means a failure
 * says whether the harness outran the runner or the runner outran itself.
 */
function ceilingFor(absoluteCeilingMs: number, probeMs: number): { ms: number; why: string } {
  const relativeCeilingMs = PROBE_CEILING_RATIO * probeMs;
  return relativeCeilingMs > absoluteCeilingMs
    ? { ms: relativeCeilingMs, why: `${PROBE_CEILING_RATIO}x a ${probeMs}ms probe` }
    : { ms: absoluteCeilingMs, why: `the ${absoluteCeilingMs}ms absolute ceiling` };
}

/** The sample carrying the ceiling every sample has to clear. */
function worstSample(samples: DelegationSample[]): DelegationSample {
  return samples.reduce((chosen, sample) =>
    netOverheadMs(sample) > netOverheadMs(chosen) ? sample : chosen,
  );
}

/** The sample closest to the measurement itself: a stall can only add to a cycle. */
function bestSample(samples: DelegationSample[]): DelegationSample {
  return samples.reduce((chosen, sample) =>
    netOverheadMs(sample) < netOverheadMs(chosen) ? sample : chosen,
  );
}

/**
 * Decide a run, from the numbers alone.
 *
 * Each sample is judged against `max(its absolute ceiling, PROBE_CEILING_RATIO * that sample's own
 * probe)`. The relative half is what makes the bound usable on a machine that has gone slow at
 * exactly this kind of work (#367); where it binds, it binds at several times the harness's normal
 * cost, so a harness an order of magnitude more expensive on a machine at normal speed is still
 * outside it — which is what the tests under this function hold down.
 */
export function judgeDelegation(
  samples: DelegationSample[],
  childRunMs: number,
  ceilings: DelegationCeilings,
): { verdict: 'pass' | 'fail' | 'inconclusive'; reason: string } {
  const context = `samples ${samples
    .map((sample) => sample.overheadMs)
    .sort((left, right) => left - right)
    .join('/')}ms · probes ${samples
    .map((sample) => sample.probeMs)
    .sort((left, right) => left - right)
    .join('/')}ms`;

  // The same precedence the measurements had: a worst sample too expensive to be the handoff is a
  // failure even on a stalling machine, a machine whose own best cycle stalled is inconclusive, and
  // only then is the best sample read as the measurement.
  const worst = worstSample(samples);
  const worstNet = netOverheadMs(worst);
  const worstCeiling = ceilingFor(ceilings.worstCeilingMs, worst.probeMs);
  if (worstNet > worstCeiling.ms) {
    return {
      verdict: 'fail',
      reason: `worst net overhead ${worstNet}ms is over the ${worstCeiling.ms}ms ceiling from ${worstCeiling.why} (${context})`,
    };
  }

  const stall = Math.min(...samples.map((sample) => sample.stallMs));
  if (stall > STALL_TOLERANCE_MS) {
    return {
      verdict: 'inconclusive',
      reason: `the machine fired a ${childRunMs}ms timer ${stall}ms late on its best cycle, so the overhead ceiling is not measurable here (${context})`,
    };
  }

  const best = bestSample(samples);
  const bestNet = netOverheadMs(best);
  const bestCeiling = ceilingFor(ceilings.bestCeilingMs, best.probeMs);
  if (bestNet > bestCeiling.ms) {
    return {
      verdict: 'fail',
      reason: `best net overhead ${bestNet}ms is over the ${bestCeiling.ms}ms ceiling from ${bestCeiling.why} (${context})`,
    };
  }

  return {
    verdict: 'pass',
    reason: `best net overhead ${bestNet}ms under the ${bestCeiling.ms}ms ceiling from ${bestCeiling.why}, worst ${worstNet}ms under ${worstCeiling.ms}ms (${context})`,
  };
}

/**
 * The judge on its own, with the numbers hand-written: the verdict is the part of this test that
 * must not depend on how the machine running it happens to be doing, so it is pinned here instead.
 */
describe('judgeDelegation', () => {
  const CHILD_RUN_MS = 200;
  const LOCAL_CEILINGS: DelegationCeilings = { bestCeilingMs: 200, worstCeilingMs: 2_000 };
  /** What five quiet runs of the measurement cost on the dev box: probes of 25-43ms. */
  const QUIET_PROBE_MS = 30;
  const sample = (overheadMs: number, probeMs: number, stallMs = 0): DelegationSample => ({
    overheadMs,
    stallMs,
    probeMs,
  });

  it('forgives the #367 run, whose machine did the harness’s work 30x slower than normal', () => {
    // The CI run that failed: overheads of 596-2130ms with the child's own timer on time, on a
    // runner whose file work ran 20-60x slow for a few seconds. The probe would have read that.
    const slowProbe = QUIET_PROBE_MS * 30;
    const samples = [596, 612, 721, 840, 2130].map((overheadMs) => sample(overheadMs, slowProbe));

    const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

    expect(verdict.verdict).toBe('pass');
    expect(verdict.reason).toMatch(/probe/);
  });

  it('still fails those overheads on a machine doing that work at normal speed', () => {
    // The same numbers with nothing wrong with the machine are a slow harness, not a slow runner.
    const samples = [596, 612, 721, 840, 2130].map((overheadMs) =>
      sample(overheadMs, QUIET_PROBE_MS),
    );

    const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/2000ms absolute ceiling/);
  });

  it('fails an order of magnitude of harness on a quiet machine', () => {
    const samples = [740, 780, 890, 930, 1470].map((overheadMs) =>
      sample(overheadMs, QUIET_PROBE_MS),
    );

    const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/best net overhead 740ms/);
  });

  it('passes a quiet healthy run', () => {
    const samples = [74, 81, 87, 94, 134].map((overheadMs) => sample(overheadMs, QUIET_PROBE_MS));

    const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

    expect(verdict.verdict).toBe('pass');
  });

  it('is inconclusive when the machine could not fire its own timer', () => {
    // Every one of five samples slow and the timer 300ms late on all of them: on the numbers alone
    // the best of them is 229ms against a 200ms ceiling, which is the runner, not the handoff.
    const samples = [529, 561, 600, 634, 667].map((overheadMs) =>
      sample(overheadMs, QUIET_PROBE_MS, 300),
    );

    const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

    expect(verdict.verdict).toBe('inconclusive');
    expect(verdict.reason).toMatch(/300ms late/);
  });
});

it('keeps foreground delegation overhead small relative to the delegated work', async () => {
  const childRunMs = 200;
  const samples: DelegationSample[] = [];
  for (let run = 0; run < 5; run += 1) {
    // The probe brackets the cycle and keeps its slower side, so the number is what this machine
    // cost on *this* cycle rather than a lull between two of them.
    const probeBefore = measureProbeMs();
    const { overheadMs, stallMs } = await measureRoundTrip(childRunMs);
    const probeAfter = measureProbeMs();
    samples.push({ overheadMs, stallMs, probeMs: Math.max(probeBefore, probeAfter) });
  }
  const sorted = samples.map((sample) => sample.overheadMs).sort((left, right) => left - right);
  const probes = samples.map((sample) => sample.probeMs).sort((left, right) => left - right);
  const verdict = judgeDelegation(samples, childRunMs, {
    bestCeilingMs: overheadCeilingMs(childRunMs),
    worstCeilingMs: 2_000,
  });

  // Printed rather than only asserted: the absolute number is the finding, and a
  // ceiling that passes tells you nothing about where the real cost sits.
  console.log(
    `[delegation] child ${childRunMs}ms · overhead best ${sorted[0]}ms · median ${sorted[Math.floor(sorted.length / 2)]}ms · worst ${sorted[sorted.length - 1]}ms · samples ${sorted.join('/')}ms · probe ${probes[0]}-${probes[probes.length - 1]}ms · timer stall ${Math.min(...samples.map((sample) => sample.stallMs))}ms · ${verdict.verdict}: ${verdict.reason}`,
  );

  expect(verdict.verdict, verdict.reason).not.toBe('fail');
}, 60_000);

/**
 * The harness's own cost for one child duration: the best of several cycles, for
 * the same reason the ceiling above is judged on the best sample -- a stall can
 * only add to a cycle, so the minimum is the measurement. The child's own timer
 * lateness is taken out as well: that is the machine, not the handoff.
 */
async function bestHarnessOverheadMs(childRunMs: number, cycles = 3): Promise<number> {
  const samples: number[] = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const { overheadMs, stallMs } = await measureRoundTrip(childRunMs);
    samples.push(Math.max(0, overheadMs - stallMs));
  }
  return Math.min(...samples);
}

it('reports overhead that does not scale with the delegated work', async () => {
  // If handoff cost tracked the child's run length, the pattern would be unusable
  // for long tasks — the case delegation is actually for. Two child durations an
  // order of magnitude apart should cost about the same to hand off.
  //
  // One-sided on purpose: "scales with the work" means the long child costs more
  // to hand off, so only that direction can fail. A Windows runner once stalled
  // the single short sample for a whole second (short=1179ms, long=62ms) and the
  // old two-sided check called that scaling. The bound is the extra work itself
  // (950ms): overhead that grew as fast as the work would reach it, and the
  // harness's real cost is ~20x below it.
  const shortChildMs = 50;
  const longChildMs = 1_000;
  const short = await bestHarnessOverheadMs(shortChildMs);
  const long = await bestHarnessOverheadMs(longChildMs);
  console.log(
    `[delegation] best overhead short(${shortChildMs}ms child)=${short}ms long(${longChildMs}ms child)=${long}ms`,
  );
  expect(long - short).toBeLessThan(longChildMs - shortChildMs);
}, 60_000);

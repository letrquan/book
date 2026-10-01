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
 * slowly raises its own ceiling — while on a quiet machine the absolute ceiling is
 * still the binding one, which is where a regression is caught.
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
 * same matrix keep the tight one. A machine doing its ordinary file work slowly raises this further,
 * which is what #367 was about, and a machine that is not slow keeps this one binding.
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
 * Measured both ways on this Windows dev box — quiet, and loaded with 12 CPU and 3 fs workers until
 * the test was starved — the overhead tracks the probe closely: the best sample costs 1.7-3.0x its
 * own probe and no sample of either run costs more than about 6.1x, while the probe itself rises
 * 3-4x under load. So 5 sits above the healthy cost with roughly 1.7x of headroom over the worst
 * best-sample ratio seen, and it costs no detection strength on a quiet machine: 5 x a quiet probe
 * (27-58ms) is 135-290ms, so at the fast end of that range the 200ms absolute ceiling is still the
 * one that binds, and the relative half only takes over on a machine whose file work has gone slow.
 */
const PROBE_CEILING_RATIO = 5;

/**
 * One cycle's numbers: what the delegation cost, what the machine was doing to the child's own
 * timer while it ran, and what the machine's file work cost around it.
 */
interface DelegationSample {
  overheadMs: number;
  /** How late the child's own timer fired: the machine's stall, measured on the same cycle. */
  stallMs: number;
  /** The same-cycle cost of `measureProbeMs()`: this machine's speed, at this moment. */
  probeMs: number;
}

/** The absolute half of the ceilings, so the judge can be exercised without measuring anything. */
interface DelegationCeilings {
  /** Every sample, net of its own stall, must clear this. */
  worstCeilingMs: number;
  /** The best sample, raw, must clear this. */
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

/**
 * The samples as they were taken, each paired with the probe that ran beside it: `overheadMs@probeMs`,
 * and `~stallMs` when the child's own timer was late. Sorting the two numbers separately would lose
 * the pairing, and the pairing is the whole finding — whether an expensive sample came with a slow
 * machine or with a slow harness.
 */
function describeSamples(samples: DelegationSample[]): string {
  return samples
    .map(
      (sample) =>
        `${sample.overheadMs}@${sample.probeMs}${sample.stallMs > 0 ? `~${sample.stallMs}` : ''}`,
    )
    .join(' ');
}

/**
 * Decide a run, from the numbers alone.
 *
 * Two checks, in the order the measurements have always had them. Every sample is judged net of its
 * own stall against `max(worstCeilingMs, PROBE_CEILING_RATIO * that sample's own probe)` — every one
 * of them, so a sample the runner's own teardown made slow cannot buy the run a pass. Then, unless
 * the machine's own best cycle stalled, the sample with the smallest *raw* overhead is read as the
 * measurement of the harness; it is judged raw, because the harness work is in the raw number and a
 * per-sample stall subtracted from it would let an event loop blocked by harness work excuse itself.
 */
function judgeDelegation(
  samples: DelegationSample[],
  childRunMs: number,
  ceilings: DelegationCeilings,
): { verdict: 'pass' | 'fail' | 'inconclusive'; reason: string } {
  const context = describeSamples(samples);

  for (const sample of samples) {
    const net = netOverheadMs(sample);
    const ceiling = ceilingFor(ceilings.worstCeilingMs, sample.probeMs);
    if (net > ceiling.ms) {
      return {
        verdict: 'fail',
        reason: `a sample's net overhead ${net}ms is over the ${ceiling.ms}ms ceiling from ${ceiling.why} (${context})`,
      };
    }
  }

  const stall = Math.min(...samples.map((sample) => sample.stallMs));
  if (stall > STALL_TOLERANCE_MS) {
    return {
      verdict: 'inconclusive',
      reason: `the machine fired a ${childRunMs}ms timer ${stall}ms late on its best cycle, so the overhead ceiling is not measurable here (${context})`,
    };
  }

  const best = samples.reduce((chosen, sample) =>
    sample.overheadMs < chosen.overheadMs ? sample : chosen,
  );
  const bestCeiling = ceilingFor(ceilings.bestCeilingMs, best.probeMs);
  if (best.overheadMs > bestCeiling.ms) {
    return {
      verdict: 'fail',
      reason: `best raw overhead ${best.overheadMs}ms is over the ${bestCeiling.ms}ms ceiling from ${bestCeiling.why} (${context})`,
    };
  }

  const worstNet = Math.max(...samples.map(netOverheadMs));
  return {
    verdict: 'pass',
    reason: `best raw overhead ${best.overheadMs}ms under the ${bestCeiling.ms}ms ceiling from ${bestCeiling.why}, every sample under its ceiling (worst net ${worstNet}ms of ${ceilings.worstCeilingMs}ms absolute) (${context})`,
  };
}

/**
 * The judge on its own, with the numbers hand-written: the verdict is the part of this test that
 * must not depend on how the machine running it happens to be doing, so it is pinned here instead.
 */
describe('judgeDelegation', () => {
  const CHILD_RUN_MS = 200;
  const LOCAL_CEILINGS: DelegationCeilings = { bestCeilingMs: 200, worstCeilingMs: 2_000 };
  /** What quiet runs of the measurement cost on the dev box: probes from 27ms up to 58ms. */
  const QUIET_PROBE_MS = { fast: 27, slow: 58 };
  const sample = (overheadMs: number, probeMs: number, stallMs = 0): DelegationSample => ({
    overheadMs,
    stallMs,
    probeMs,
  });

  it('forgives the #367 run, whose machine did the harness’s work 30x slower than normal', () => {
    // The CI run that failed: overheads of 596-2130ms with the child's own timer on time, on a
    // runner whose file work ran 20-60x slow for a few seconds. The probe would have read that.
    const slowProbe = QUIET_PROBE_MS.fast * 30;
    const samples = [596, 612, 721, 840, 2130].map((overheadMs) => sample(overheadMs, slowProbe));

    const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

    expect(verdict.verdict).toBe('pass');
    expect(verdict.reason).toMatch(/probe/);
  });

  it('still fails those overheads on a machine doing that work at normal speed', () => {
    // The same numbers with nothing wrong with the machine are a slow harness, not a slow runner.
    const samples = [596, 612, 721, 840, 2130].map((overheadMs) =>
      sample(overheadMs, QUIET_PROBE_MS.fast),
    );

    const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/2000ms absolute ceiling/);
  });

  // The quiet range is 27-58ms of probe, and a ceiling set from one end of it has to hold at the
  // other: the slow end is where the relative ceiling outgrows the 200ms absolute one, and the fast
  // end is where the absolute one still has to be what catches the regression.
  it.each([QUIET_PROBE_MS.fast, QUIET_PROBE_MS.slow])(
    'fails an order of magnitude of harness at a quiet probe of %ims',
    (probeMs) => {
      const samples = [740, 780, 890, 930, 1470].map((overheadMs) => sample(overheadMs, probeMs));

      const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

      expect(verdict.verdict).toBe('fail');
    },
  );

  it.each([QUIET_PROBE_MS.fast, QUIET_PROBE_MS.slow])(
    'passes a quiet healthy run at a probe of %ims',
    (probeMs) => {
      const samples = [74, 81, 87, 94, 134].map((overheadMs) => sample(overheadMs, probeMs));

      const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

      expect(verdict.verdict).toBe('pass');
    },
  );

  it('fails a sample over its own ceiling even when the largest overhead has a looser one', () => {
    // The review's case: a 2500ms cycle came with a 10ms probe, so its ceiling is the 2000ms
    // absolute, and a 3000ms one came with a 200ms probe. Both are out, and the run has to name the
    // 2500ms one, because a judge that read only the largest overhead would report the other and
    // never have looked at the sample with the tighter ceiling.
    const samples = [sample(2500, 10), sample(3000, 200)];

    const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/2500ms/);
    expect(verdict.reason).toMatch(/2000ms absolute ceiling/);
  });

  it('fails on the smaller cycle when the larger one is under its own ceiling', () => {
    // Where the relative half is what binds: a machine so slow that 5x its probe is past the
    // absolute ceiling. The 2600ms cycle ran beside a 500ms probe (ceiling 2500) and the 3000ms one
    // beside a 2000ms probe (ceiling 10000), so the largest overhead is comfortably inside its own
    // ceiling, and judging only that one would pass a run whose other cycle was over.
    const samples = [sample(3000, 2_000), sample(2600, 500)];

    const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/2600ms/);
    expect(verdict.reason).toMatch(/5x a 500ms probe/);
  });

  it('fails a best sample whose raw overhead is out of bounds, stall or not', () => {
    // The best raw sample is 600ms, and 450ms of it is its own timer running late: read net, that
    // is 150ms against a 200ms ceiling and the run would pass. The other cycle stalled only 50ms,
    // so the stall guard does not fire either. The harness cost is the raw 600ms.
    const samples = [sample(600, 30, 450), sample(650, 30, 50)];

    const verdict = judgeDelegation(samples, CHILD_RUN_MS, LOCAL_CEILINGS);

    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/best raw overhead 600ms/);
  });

  it('is inconclusive when the machine could not fire its own timer', () => {
    // Every one of five samples slow and the timer 300ms late on all of them: on the numbers alone
    // the best of them is 529ms against a 200ms ceiling, which is the runner, not the handoff.
    const samples = [529, 561, 600, 634, 667].map((overheadMs) =>
      sample(overheadMs, QUIET_PROBE_MS.fast, 300),
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
  const verdict = judgeDelegation(samples, childRunMs, {
    bestCeilingMs: overheadCeilingMs(childRunMs),
    worstCeilingMs: 2_000,
  });

  // Printed rather than only asserted: the absolute number is the finding, and a
  // ceiling that passes tells you nothing about where the real cost sits. The verdict's own
  // reason carries each sample beside the probe that ran with it, which is the pairing.
  console.log(
    `[delegation] child ${childRunMs}ms · overhead best ${sorted[0]}ms · median ${sorted[Math.floor(sorted.length / 2)]}ms · worst ${sorted[sorted.length - 1]}ms · timer stall ${Math.min(...samples.map((sample) => sample.stallMs))}ms · ${verdict.verdict}: ${verdict.reason}`,
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

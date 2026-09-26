import type { AgentRecord, AgentSpawnRequest, SpawnerClaim } from './types.js';

type ClaimedRun = Pick<AgentRecord, 'runSequence' | 'spawnerClaim'>;

/** The claim a spawn request makes on the agent's first run, or none for the ordinary rules. */
export function spawnerClaimFor(
  request: Pick<AgentSpawnRequest, 'notifyParentOnCompletion' | 'resumeAfterRestart'>,
): SpawnerClaim | undefined {
  if (request.notifyParentOnCompletion !== false && request.resumeAfterRestart !== false) {
    return undefined;
  }
  return {
    throughRunSequence: 1,
    ...(request.notifyParentOnCompletion === false ? { notifyParent: false as const } : {}),
    ...(request.resumeAfterRestart === false ? { resumeAfterRestart: false as const } : {}),
  };
}

/** Whether the run the record is on (queued, running, or just ended) is the spawner's. */
export function inSpawnerRun(record: ClaimedRun): boolean {
  return (
    record.spawnerClaim !== undefined &&
    (record.runSequence ?? 0) <= record.spawnerClaim.throughRunSequence
  );
}

/** Whether this run's terminal result is delivered to the parent session. */
export function notifiesParent(record: ClaimedRun): boolean {
  return !(inSpawnerRun(record) && record.spawnerClaim?.notifyParent === false);
}

/** Whether `agents.resumeInterrupted` may re-run this run after the process died. */
export function resumesAfterRestart(record: ClaimedRun): boolean {
  return !(inSpawnerRun(record) && record.spawnerClaim?.resumeAfterRestart === false);
}

/**
 * Number the next run as it is queued. It stays the spawner's only when `continuesSpawnerRun`
 * says the spawner still waits on it and the run it follows was the spawner's. Any other run is
 * past the claim, so no path has to clear anything for the parent to receive it.
 */
export function advanceRun(record: ClaimedRun, continuesSpawnerRun: boolean): void {
  const continuing = continuesSpawnerRun && inSpawnerRun(record);
  // A record written before runs were numbered is on run 1 (`run()` numbers it that way when it
  // starts), so the next run is 2. Numbering it 1 would repeat a run, and land inside a claim
  // whose lowest covered run is 1.
  record.runSequence = (record.runSequence ?? 1) + 1;
  if (continuing && record.spawnerClaim) {
    record.spawnerClaim.throughRunSequence = record.runSequence;
  }
}

/**
 * The follow-ups an interrupted run leaves unrun: the one it was running, when that was not the
 * spawn task, and those queued behind it.
 */
export function unrunFollowUps(
  record: Pick<AgentRecord, 'purpose' | 'prompt' | 'pendingMessages'>,
): string[] {
  return [
    ...(record.purpose !== undefined && record.prompt !== record.purpose ? [record.prompt] : []),
    ...(record.pendingMessages ?? []),
  ];
}

interface LegacyDeliveryFlags {
  notifyParentOnCompletion?: boolean;
  resumeAfterRestart?: boolean;
}

/**
 * Records written before per-run claims carried two record-level flags, which every path that
 * started a run the spawner no longer waited on cleared by hand; while set, they described the
 * run the record was on. Read them as a claim through that run, or through the first run for a
 * record that never started.
 */
export function migrateSpawnerClaim<T extends ClaimedRun>(record: T & LegacyDeliveryFlags): T {
  const { notifyParentOnCompletion, resumeAfterRestart, ...rest } = record;
  const migrated = rest as unknown as T;
  const claim = spawnerClaimFor({ notifyParentOnCompletion, resumeAfterRestart });
  if (migrated.spawnerClaim !== undefined || claim === undefined) {
    return migrated;
  }
  // A record that never started claims its first run, and is on it: leaving `runSequence`
  // undefined would have `advanceRun` number the next run 1, inside the claim.
  const throughRunSequence = Math.max(migrated.runSequence ?? 0, claim.throughRunSequence);
  return {
    ...migrated,
    runSequence: migrated.runSequence ?? throughRunSequence,
    spawnerClaim: { ...claim, throughRunSequence },
  };
}

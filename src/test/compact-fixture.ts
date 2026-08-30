/**
 * The planted-fact corpus that compaction fidelity is scored against.
 *
 * It lives in `src/test/` -- where CLAUDE.md puts shared fixtures -- rather
 * than in `scripts/`, so the deterministic CI tier can use it: `scripts/`
 * importing `src/` is established, the reverse is not, and a unit-tier fidelity
 * harness must not depend on a benchmark script.
 *
 * The history is the one the provider-backed `npm run eval:compact` benchmark
 * already used, unchanged, so both tiers score the same conversation. What is
 * new here is `PLANTED_FACTS`: the same facts the benchmark probes for, tagged
 * by kind and expressed as literal terms, so a scorer can find them in a
 * checkpoint without a model in the loop.
 */

import type { Message } from '../types/messages.js';
import type { FileObservation } from '../types/tools.js';
import { toolSuccess } from '../tools/result.js';

/**
 * What kind of thing a planted fact is. Compaction is not equally obliged to
 * keep all of them: a `user-constraint` stated verbatim must survive, while a
 * `superseded-value` must survive only as history and must never be presented
 * as current.
 */
export type PlantedFactKind =
  | 'user-constraint'
  | 'accepted-decision'
  | 'rejected-decision'
  | 'current-value'
  | 'superseded-value'
  | 'open-thread'
  | 'timeline-event';

export interface PlantedFact {
  id: string;
  kind: PlantedFactKind;
  /** Literal terms that must all appear for the fact to count as retained. */
  terms: string[];
  /** For a `current-value`: the id of the `superseded-value` it replaced. */
  supersedes?: string;
  /** Messages carrying the evidence, for source-grounding checks. */
  sourceMessageIds: string[];
}

export interface CompactFixtureHistory {
  history: Message[];
  /** Turn handles, so a caller can map a fact back to its evidence messages. */
  turns: Record<string, { userId: string; assistantId: string }>;
}

function makeMessage(role: Message['role'], content: string, index: number): Message {
  return {
    id: `compact-eval-${index}`,
    role,
    content,
    includeInContext: true,
    kind: 'conversation',
    timestamp: index,
  };
}

/**
 * The handoff-state-and-history corpus: constraints and decisions early, a long
 * run of filler, then updates that supersede earlier values, then more filler.
 * The shape is deliberate -- the facts that must survive are the ones furthest
 * from the retained tail.
 */
export function buildCompactFixtureHistory(): CompactFixtureHistory {
  const history: Message[] = [];
  let index = 0;
  const addTurn = (user: string, assistant: string): { userId: string; assistantId: string } => {
    const userMessage = makeMessage('user', user, index++);
    const assistantMessage = makeMessage('assistant', assistant, index++);
    history.push(userMessage, assistantMessage);
    return { userId: userMessage.id, assistantId: assistantMessage.id };
  };

  const runtime = addTurn(
    'Record the project constraints for the handoff. The runtime must remain Node.js 20 or newer. Do not change the public query() function signature.',
    'Recorded constraints: runtime is Node.js 20 or newer; the public query() function signature must remain unchanged.',
  );
  const cache = addTurn(
    'The accepted cache key is workspaceHash:modelId:v3. We rejected Redis because the benchmark must work offline and without a service dependency.',
    'Accepted decision: use workspaceHash:modelId:v3. Rejected decision: Redis, because offline execution is required.',
  );
  const openThread = addTurn(
    'There is one unresolved issue from the last run: the Windows CRLF fixture still fails and must remain an open thread until verified.',
    'Open thread recorded: the Windows CRLF fixture still fails and needs verification.',
  );
  const oldRegion = addTurn(
    'Initial deployment note: the staging region is us-east-1. This value may change after the migration.',
    'The initial staging region is recorded as us-east-1, pending migration.',
  );
  const wrongPackageManager = addTurn(
    'For now, assume npm is the package manager until the maintainer confirms the repository convention.',
    'Temporary assumption recorded: npm, awaiting an authoritative maintainer correction.',
  );

  const filler =
    'We inspected an unrelated implementation detail and found no change required. Keep the discussion scoped to the handoff, preserve existing behavior, and report evidence before claiming completion. ';
  const addFiller = (turn: number): void => {
    addTurn(
      `Unrelated investigation ${turn}: ${filler.repeat(3)}The result was informational only.`,
      `Investigation ${turn} is complete. No constraint, accepted decision, current value, or open thread changed. ${filler.repeat(3)}`,
    );
  };
  for (let turn = 1; turn <= 8; turn++) addFiller(turn);

  const currentRegion = addTurn(
    'Migration update: staging has moved successfully. The current deployment region is now eu-west-1; us-east-1 is historical only.',
    'Current state updated: staging region is eu-west-1. The earlier us-east-1 value is superseded.',
  );
  const packageCorrection = addTurn(
    'Maintainer correction: this repository requires pnpm 9. The earlier npm assumption was wrong and must not be used.',
    'Authoritative convention updated: use pnpm 9. The npm assumption is rejected.',
  );
  const mondayFailure = addTurn(
    'Monday verification event: the integration suite failed before the adapter patch was applied.',
    'Timeline recorded: integration failed on Monday.',
  );
  const tuesdayPatch = addTurn(
    'Tuesday verification event: the adapter patch was applied, but the suite was not run yet.',
    'Timeline recorded: adapter patch applied Tuesday; verification still pending.',
  );
  const apiUnits = addTurn(
    'Interface fact: the upstream API returns duration values in milliseconds.',
    'Recorded: upstream durations use milliseconds.',
  );

  for (let turn = 9; turn <= 16; turn++) addFiller(turn);

  const wednesdayPass = addTurn(
    'Wednesday verification event: the integration suite passed for the first time with the adapter patch.',
    'Timeline recorded: first passing integration run was Wednesday.',
  );
  const databaseUnits = addTurn(
    'Storage fact: the database persists duration values in whole seconds.',
    'Recorded: stored durations use seconds.',
  );
  const adapterRule = addTurn(
    'Implementation decision: the adapter converts API milliseconds to database seconds by dividing by 1000.',
    'Accepted conversion: milliseconds to seconds, divide by 1000 in the adapter.',
  );
  const thursdayRevert = addTurn(
    'Thursday verification event: the adapter patch was reverted after a separate regression. It is not active now.',
    'Current timeline state: the adapter patch was reverted Thursday and is no longer active.',
  );

  for (let turn = 17; turn <= 20; turn++) addFiller(turn);

  addTurn(
    'Continue the handoff from the established record. Summarize only new evidence from this latest inspection.',
    'The latest inspection found no new evidence and did not modify the established record.',
  );
  addTurn(
    'Before the next check, keep current values, accepted conventions, and unresolved verification items in view.',
    'Current values and unresolved verification state remain in view; no historical value became current again.',
  );

  return {
    history,
    turns: {
      runtime,
      cache,
      openThread,
      oldRegion,
      wrongPackageManager,
      currentRegion,
      packageCorrection,
      mondayFailure,
      tuesdayPatch,
      apiUnits,
      wednesdayPass,
      databaseUnits,
      adapterRule,
      thursdayRevert,
    },
  };
}

/**
 * The facts the corpus plants, as literal terms. These mirror the probe
 * expectations the provider-backed benchmark grades against, so a regression
 * visible here is a regression there.
 */
export function buildPlantedFacts(turns: CompactFixtureHistory['turns']): PlantedFact[] {
  return [
    {
      id: 'runtime-constraint',
      kind: 'user-constraint',
      terms: ['Node.js 20'],
      sourceMessageIds: [turns.runtime.userId, turns.runtime.assistantId],
    },
    {
      id: 'public-api-constraint',
      kind: 'user-constraint',
      terms: ['query()'],
      sourceMessageIds: [turns.runtime.userId, turns.runtime.assistantId],
    },
    {
      id: 'cache-key-decision',
      kind: 'accepted-decision',
      terms: ['workspaceHash:modelId:v3'],
      sourceMessageIds: [turns.cache.userId, turns.cache.assistantId],
    },
    {
      id: 'redis-rejection',
      kind: 'rejected-decision',
      terms: ['Redis'],
      sourceMessageIds: [turns.cache.userId, turns.cache.assistantId],
    },
    {
      id: 'crlf-open-thread',
      kind: 'open-thread',
      terms: ['CRLF'],
      sourceMessageIds: [turns.openThread.userId, turns.openThread.assistantId],
    },
    {
      id: 'region-old',
      kind: 'superseded-value',
      terms: ['us-east-1'],
      sourceMessageIds: [turns.oldRegion.userId, turns.oldRegion.assistantId],
    },
    {
      id: 'region-current',
      kind: 'current-value',
      terms: ['eu-west-1'],
      supersedes: 'region-old',
      sourceMessageIds: [turns.currentRegion.userId, turns.currentRegion.assistantId],
    },
    {
      id: 'package-manager-old',
      kind: 'superseded-value',
      terms: ['npm'],
      sourceMessageIds: [turns.wrongPackageManager.userId, turns.wrongPackageManager.assistantId],
    },
    {
      id: 'package-manager-current',
      kind: 'current-value',
      terms: ['pnpm'],
      supersedes: 'package-manager-old',
      sourceMessageIds: [turns.packageCorrection.userId, turns.packageCorrection.assistantId],
    },
    {
      id: 'conversion-decision',
      kind: 'accepted-decision',
      terms: ['1000'],
      sourceMessageIds: [turns.adapterRule.userId, turns.adapterRule.assistantId],
    },
    {
      id: 'first-passing-day',
      kind: 'timeline-event',
      terms: ['Wednesday'],
      sourceMessageIds: [turns.wednesdayPass.userId, turns.wednesdayPass.assistantId],
    },
    {
      id: 'patch-reverted',
      kind: 'timeline-event',
      terms: ['Thursday'],
      sourceMessageIds: [turns.thursdayRevert.userId, turns.thursdayRevert.assistantId],
    },
  ];
}

/**
 * A second corpus whose facts live in tool arguments, tool-result bodies and
 * file observations rather than in message prose.
 *
 * This is the path that silently mis-scored before: quotes are validated
 * against the serialized message body, and a file is only "observed" through a
 * real `fileObservation` or tool argument -- naming it in prose does not count.
 * Both rules are invisible to a prose-only fixture.
 */
export function buildToolHeavyFixtureHistory(): CompactFixtureHistory {
  const history: Message[] = [];
  let index = 0;
  const observation = (path: string, timestamp: number): FileObservation => ({
    path,
    workspaceId: 'fixture',
    sha256: `${timestamp}`.padStart(64, '0'),
    byteSize: 512,
    operation: 'read',
    sourceRef: `session://current/event/tool-fixture-${timestamp}`,
    timestamp,
  });

  const userId = `tool-fixture-${index++}`;
  history.push({
    id: userId,
    role: 'user',
    content: 'Find why the release build fails and keep the exact compiler error.',
    includeInContext: true,
    kind: 'conversation',
    timestamp: 0,
  });

  const assistantId = `tool-fixture-${index++}`;
  history.push({
    id: assistantId,
    role: 'assistant',
    content: `Inspecting the build. ${'Checking the toolchain. '.repeat(400)}`,
    includeInContext: true,
    kind: 'conversation',
    timestamp: 1,
    toolCalls: [
      { id: 'call-build', name: 'Bash', arguments: { command: 'npm run build' } },
      { id: 'call-read', name: 'Read', arguments: { file_path: 'src/adapter.ts' } },
    ],
    toolResults: [
      toolSuccess(
        'TS2345: Argument of type string is not assignable to parameter of type number.',
        {
          toolCallId: 'call-build',
        },
      ),
      toolSuccess('export function convert(ms: string) {}', { toolCallId: 'call-read' }),
    ],
    fileObservations: [observation('src/adapter.ts', 1)],
  });

  const fillerId = `tool-fixture-${index++}`;
  history.push({
    id: fillerId,
    role: 'user',
    content: `Continue. ${'Unrelated detail. '.repeat(2_000)}`,
    includeInContext: true,
    kind: 'conversation',
    timestamp: 2,
  });
  const fillerReplyId = `tool-fixture-${index++}`;
  history.push({
    id: fillerReplyId,
    role: 'assistant',
    content: `Nothing else changed. ${'Unrelated detail. '.repeat(2_000)}`,
    includeInContext: true,
    kind: 'conversation',
    timestamp: 3,
  });

  const tailId = `tool-fixture-${index++}`;
  history.push({
    id: tailId,
    role: 'user',
    content: 'What is the error?',
    includeInContext: true,
    kind: 'conversation',
    timestamp: 4,
  });
  const tailReplyId = `tool-fixture-${index++}`;
  history.push({
    id: tailReplyId,
    role: 'assistant',
    content: 'The adapter takes a string where a number is required.',
    includeInContext: true,
    kind: 'conversation',
    timestamp: 5,
  });

  return {
    history,
    turns: {
      build: { userId, assistantId },
      filler: { userId: fillerId, assistantId: fillerReplyId },
      tail: { userId: tailId, assistantId: tailReplyId },
    },
  };
}

/** Facts planted in tool output and file observations rather than in prose. */
export function buildToolHeavyPlantedFacts(turns: CompactFixtureHistory['turns']): PlantedFact[] {
  return [
    {
      id: 'compiler-error',
      kind: 'open-thread',
      terms: ['TS2345'],
      sourceMessageIds: [turns.build.assistantId],
    },
    {
      id: 'observed-file',
      kind: 'current-value',
      terms: ['src/adapter.ts'],
      sourceMessageIds: [turns.build.assistantId],
    },
  ];
}

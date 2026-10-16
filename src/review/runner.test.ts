import { describe, expect, it } from 'vitest';
import type { AgentManager } from '../agents/manager.js';
import { fixRunnerFor, reviewRunnerFor } from './runner.js';

interface SpawnRequest {
  agent: string;
  parentSessionId?: string;
  rootRunId?: string;
  parentRunId?: string;
  notifyParentOnCompletion?: boolean;
}

function recordingManager(): { manager: AgentManager; spawns: SpawnRequest[] } {
  const spawns: SpawnRequest[] = [];
  const manager = {
    async spawn(request: SpawnRequest) {
      spawns.push(request);
      return { id: `agent-${spawns.length}`, status: 'queued' };
    },
  };
  return { manager: manager as unknown as AgentManager, spawns };
}

const attribution = { parentSessionId: 'host-session', rootRunId: 'root-1', parentRunId: 'run-1' };

describe('review runners — session attribution (#448)', () => {
  it('hands the host session, root and run to every agent a review runner spawns', async () => {
    const { manager, spawns } = recordingManager();
    const runner = reviewRunnerFor(manager, attribution);

    await runner.spawn('reviewer', 'review this');
    await runner.spawn('reviewer', 'verify this');

    expect(spawns).toHaveLength(2);
    for (const spawn of spawns) {
      expect(spawn).toMatchObject({ ...attribution, notifyParentOnCompletion: false });
    }
  });

  it('carries the same attribution to the --fix patcher and validator runner', async () => {
    const { manager, spawns } = recordingManager();
    const runner = fixRunnerFor(manager, attribution);

    await runner.spawn('patcher', 'fix this');
    await runner.spawn('validator', 'check the patch');

    expect(spawns.map((spawn) => spawn.agent)).toEqual(['patcher', 'validator']);
    for (const spawn of spawns) expect(spawn).toMatchObject(attribution);
  });
});

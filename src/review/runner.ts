import type { AgentManager } from '../agents/manager.js';
import type { EvidenceItem } from '../agents/types.js';
import type { FixAgentRunner, FixEvidence } from './fix.js';
import type { ReviewAgentRunner } from './orchestration.js';

function evidenceProjection(item: EvidenceItem): FixEvidence {
  return {
    id: item.id,
    verificationState: item.verificationState,
    verdict: item.verdict,
    reviewNotes: item.reviewNotes,
  };
}

export function reviewRunnerFor(manager: AgentManager): ReviewAgentRunner {
  return {
    async spawn(agent, prompt, options) {
      const record = await manager.spawn({
        agent,
        prompt,
        description: options?.description,
        evidenceIds: options?.evidenceIds,
      });
      return {
        id: record.id,
        status: record.status,
        result: record.result,
        error: record.error,
        producedEvidenceIds: record.producedEvidenceIds,
      };
    },
    async wait(id, timeoutMs) {
      const record = await manager.wait(id, timeoutMs);
      return {
        id: record.id,
        status: record.status,
        result: record.result,
        error: record.error,
        producedEvidenceIds: record.producedEvidenceIds,
      };
    },
    async stop(id, reason) {
      await manager.stop(id, reason);
    },
  };
}

export function fixRunnerFor(manager: AgentManager): FixAgentRunner {
  return {
    ...reviewRunnerFor(manager),
    async findPatchCandidateEvidence(agentId) {
      const evidence = (await manager.listEvidence())
        .filter(
          (item) =>
            item.sourceAgentId === agentId &&
            item.kind === 'patch_candidate' &&
            item.patchCandidate !== undefined,
        )
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      return evidence ? evidenceProjection(evidence) : undefined;
    },
    async getEvidence(evidenceId) {
      const evidence = (await manager.listEvidence({ ids: [evidenceId] }))[0];
      return evidence ? evidenceProjection(evidence) : undefined;
    },
    async apply(agentId, evidenceId) {
      const result = await manager.apply(agentId, evidenceId);
      return { status: result.status, commit: result.commit, error: result.error };
    },
  };
}

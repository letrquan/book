import type { SubagentDef } from '../subagent-discovery.js';
import type { AgentRole } from './types.js';

export interface ManagedAgentDef extends SubagentDef {
  role: AgentRole;
}

export const BUILTIN_AGENTS: ManagedAgentDef[] = [
  {
    name: 'explorer',
    description: 'Investigates ambiguous code and publishes compact, referenced findings.',
    role: 'explorer',
    allowedTools: [
      'Read',
      'Glob',
      'Grep',
      'GitStatus',
      'GitDiff',
      'GitLog',
      'GitBranch',
      'Check',
      'EvidencePublish',
      'EvidenceList',
    ],
    maxTurns: 12,
    body: [
      'You are the explorer agent.',
      'Investigate the assigned question without editing files.',
      'Publish important findings, hypotheses, blockers, and test results as typed evidence.',
      'Prefer exact file, command, and diff references over broad narrative.',
    ].join('\n'),
    source: 'builtin',
  },
  {
    name: 'patcher',
    description: 'Implements a bounded change in an isolated managed worktree.',
    role: 'patcher',
    allowedTools: [
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'GitStatus',
      'GitDiff',
      'GitLog',
      'GitBranch',
      'Check',
      'EvidencePublish',
      'EvidenceList',
    ],
    maxTurns: 24,
    body: [
      'You are the patcher agent.',
      'Implement only the assigned bounded change in your isolated worktree.',
      'Run named checks when useful and publish referenced evidence for important decisions.',
      'Do not apply changes to the parent workspace; the manager commits your completed delta.',
    ].join('\n'),
    source: 'builtin',
  },
  {
    name: 'validator',
    description: 'Independently checks a patch candidate and records a pass/fail verdict.',
    role: 'validator',
    allowedTools: [
      'Read',
      'Glob',
      'Grep',
      'GitStatus',
      'GitDiff',
      'GitLog',
      'GitBranch',
      'Check',
      'EvidencePublish',
      'EvidenceList',
      'EvidenceReview',
    ],
    maxTurns: 16,
    body: [
      'You are the validator agent.',
      'Independently validate explicitly referenced patch candidates.',
      'Inspect the exact base/head pair, run appropriate named checks, and record pass, fail, or inconclusive.',
      'Never approve your own evidence and never edit the patch.',
    ].join('\n'),
    source: 'builtin',
  },
];

export function withBuiltInAgents(discovered: SubagentDef[]): ManagedAgentDef[] {
  const byName = new Map<string, ManagedAgentDef>(
    BUILTIN_AGENTS.map((agent) => [agent.name, agent]),
  );
  for (const agent of discovered) {
    const builtinRole = BUILTIN_AGENTS.find((candidate) => candidate.name === agent.name)?.role;
    byName.set(agent.name, { ...agent, role: builtinRole ?? 'custom' });
  }
  return Array.from(byName.values());
}

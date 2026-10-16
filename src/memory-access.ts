import { join } from 'path';
import type { AgentConfig } from './types/runtime.js';
import { evaluatePermission } from './permissions.js';

/**
 * Whether the user's `deny` rules would refuse the model a write to a memory file. Asked of the real
 * permission evaluator, with the memory directory as the write root, so a rule spelled as a glob
 * or a relative path counts exactly as it does when the write is made.
 *
 * Shared by the system prompt (`memorySection`) and `/memory consolidate`, which must agree on
 * whether memory is writable in this session.
 */
export function denyRulesRefuseMemoryWrites(config: AgentConfig, memoryDir: string): boolean {
  if (config.settings.permissions.deny.length === 0) return false;
  const decision = evaluatePermission(
    'Write',
    { filePath: join(memoryDir, 'x.md'), content: '' },
    config.settings,
    {
      workspace: {
        root: config.workspace,
        memoryWrite: { root: memoryDir },
        judgeReads: false,
        refuseUnreachableReads: false,
        autoAllowReads: false,
      },
    },
  );
  return decision === 'deny';
}

import { fileTools } from './file.js';
import { patchTools } from './patch.js';
import { shellTools } from './shell.js';
import { gitTools } from './git.js';
import { todoTools } from './todo.js';
import { webTools } from './web.js';
import { skillsTool } from './skills-tool.js';
import { taskTool } from './task-tool.js';
import { taskTools } from './tasks.js';
import { planModeTools } from './plan-mode.js';
import { notebookTools } from './notebook.js';
import { createSessionHistoryTools, type SessionHistoryCapability } from './session-history.js';
import { askUserQuestionTools } from './ask-user-question.js';
import { agentLifecycleTools, evidenceTools } from './agent-tools.js';
import { checkTools } from '../agents/check.js';
import { toolSearchTools } from './tool-search.js';
import { createRegistry, type ToolRegistry } from './registry-core.js';

export { createRegistry } from './registry-core.js';
export type { PreparedToolCall, ToolRegistry } from './registry-core.js';

export function createDefaultRegistry(capabilities?: {
  sessionHistory?: SessionHistoryCapability;
  agents?: boolean;
}): ToolRegistry {
  const registry = createRegistry();
  registry.registerAll([
    ...toolSearchTools,
    ...patchTools,
    ...fileTools,
    ...shellTools,
    ...gitTools,
    ...todoTools,
    ...webTools,
    ...skillsTool,
    ...taskTools,
    ...planModeTools,
    ...askUserQuestionTools,
    ...notebookTools,
  ]);
  if (capabilities?.agents !== false) {
    registry.registerAll([...agentLifecycleTools, ...evidenceTools, ...taskTool, ...checkTools]);
  }
  if (capabilities?.sessionHistory) {
    registry.registerAll(createSessionHistoryTools(capabilities.sessionHistory));
  }
  return registry;
}

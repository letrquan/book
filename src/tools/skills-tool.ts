import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { discoverSkills } from '../skills.js';
import { toolFailure, toolSuccess } from './result.js';

/**
 * InvokeSkill tool — allows the model to invoke a loaded skill by name.
 * Returns the skill's body as the tool output, which the model can then follow.
 */
async function invokeSkill(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const skillName = args.skill as string;
  const promptArgs = (args.args as string) ?? '';
  const extraContext = (args.context as string) ?? '';

  if (!skillName) {
    return toolFailure("Missing required 'skill' argument");
  }

  const skills = discoverSkills(ctx.workspaceRoot);
  const skill = skills.find((s) => s.name === skillName);

  if (!skill) {
    const available = skills.map((s) => `  - **${s.name}**: ${s.description}`).join('\n');
    return toolFailure(
      `Skill not found: "${skillName}".\nAvailable skills:\n${available || '  (none)'}`,
      { code: 'skill_not_found' },
    );
  }

  // Increment invocation count for budget tracking.
  skill.invocationCount++;
  if (skill.allowedTools) ctx.toolDiscovery?.restrict(skill.allowedTools);

  // Build the skill output.
  let output = `# Invoking skill: ${skill.name}\n\n`;
  if (skill.description) output += `${skill.description}\n\n`;
  output += skill.body;

  if (promptArgs) {
    output += `\n\n## Arguments\n${promptArgs}`;
  }
  if (extraContext) {
    output += `\n\n## Context\n${extraContext}`;
  }

  return toolSuccess(output, { data: { skill: skill.name } });
}

export const skillsTool: ToolDefinition[] = [
  {
    name: 'InvokeSkill',
    description:
      'Load and invoke a named skill by its prompt. Skills are Markdown instructions packaged with metadata. Returns the skill body for you to execute. Check the available skills listing in your system prompt.',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'The name of the skill to invoke (e.g. "code-review", "deploy")',
        },
        args: {
          type: 'string',
          description: 'Arguments to pass to the skill (optional)',
        },
        context: {
          type: 'string',
          description: 'Additional context to append (optional)',
        },
      },
      required: ['skill'],
    },
    execute: invokeSkill,
  },
];

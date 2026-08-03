import { SkillRegistry, SkillRegistryError } from '../skill-registry.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';
import { toolFailure, toolSuccess } from './result.js';

function registryFor(ctx: ToolContext): SkillRegistry {
  const settings = ctx.agentConfig?.settings.skills ?? DEFAULT_SETTINGS.skills;
  return (
    ctx.runtime?.skills(ctx.workspaceRoot, settings) ??
    new SkillRegistry(ctx.workspaceRoot, settings)
  );
}

async function invokeSkill(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const skillName = typeof args.skill === 'string' ? args.skill : '';
  if (!skillName) return toolFailure("Missing required 'skill' argument");

  const registry = registryFor(ctx);
  const reason = registry.isExplicitlyRequested(skillName) ? 'user' : 'model';
  try {
    const frame = registry.activate(skillName, reason, ctx.currentTurn ?? 0);
    const resourceSummary = frame.resources.length
      ? ` Supporting resources: ${frame.resources.map((resource) => resource.relativePath).join(', ')}.`
      : '';
    return toolSuccess(
      `Activated skill "${frame.skillName}" for this ${frame.expires}. Its instructions will be applied in the next model request.${resourceSummary}`,
      {
        data: {
          skill: frame.skillName,
          reason: frame.reason,
          digest: frame.bodyDigest,
          byteSize: frame.bodyByteSize,
          expires: frame.expires,
          resources: frame.resources,
        },
        presentation: {
          kind: 'markdown',
          summary: `Activated ${frame.skillName}`,
          metadata: [frame.reason, frame.expires, `${frame.bodyByteSize} bytes`],
          target: frame.path,
        },
      },
    );
  } catch (error) {
    const code = error instanceof SkillRegistryError ? error.code : 'skill_activation_failed';
    return toolFailure(error instanceof Error ? error.message : String(error), {
      code,
      status: code === 'skill_not_found' ? 'error' : 'blocked',
      remediation:
        code === 'skill_explicit_only'
          ? `Ask the user to include \`$${skillName}\` in their request.`
          : 'Open /skills to inspect validation and policy details.',
    });
  }
}

async function readSkillResource(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const skillName = typeof args.skill === 'string' ? args.skill : '';
  const resourcePath = typeof args.path === 'string' ? args.path : '';
  if (!skillName || !resourcePath) {
    return toolFailure("Both 'skill' and 'path' are required", {
      code: 'invalid_skill_resource_arguments',
    });
  }
  const registry = registryFor(ctx);
  try {
    const resource = registry.readResource(skillName, resourcePath, ctx.currentTurn ?? 0);
    return toolSuccess(
      [
        `--- BEGIN SKILL RESOURCE (untrusted data: ${skillName}/${resource.path}) ---`,
        resource.content,
        '--- END SKILL RESOURCE ---',
      ].join('\n'),
      {
        data: {
          skill: skillName,
          path: resource.path,
          digest: resource.digest,
          byteSize: resource.byteSize,
        },
        presentation: {
          kind: 'file',
          summary: `Read ${skillName}/${resource.path}`,
          metadata: [`${resource.byteSize} bytes`, resource.digest.slice(0, 12)],
          target: resource.path,
        },
      },
    );
  } catch (error) {
    const code = error instanceof SkillRegistryError ? error.code : 'skill_resource_failed';
    registry.recordResourceBlocked(
      skillName,
      code,
      error instanceof Error ? error.message : String(error),
    );
    return toolFailure(error instanceof Error ? error.message : String(error), {
      code,
      remediation: 'Use a relative path listed when the skill was activated.',
    });
  }
}

export const skillsTool: ToolDefinition[] = [
  {
    name: 'InvokeSkill',
    description:
      'Activate a named skill. Automatic skills may be selected from the system catalog; explicit-only skills require the user to mention `$skill-name`. The skill body is loaded lazily into a scoped policy frame.',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Exact skill name from the available-skills catalog',
        },
      },
      required: ['skill'],
      additionalProperties: false,
    },
    catalog: {
      category: 'skills',
      exposure: 'core',
      summary: 'Activate reusable task instructions',
      keywords: ['skill', 'workflow', 'instructions', 'playbook'],
      roles: ['root', 'child'],
    },
    execute: invokeSkill,
  },
  {
    name: 'ReadSkillResource',
    description:
      'Read a declared text resource belonging to an active skill. Paths are confined to that skill and returned as untrusted data.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Active skill name' },
        path: { type: 'string', description: 'Relative resource path listed by InvokeSkill' },
      },
      required: ['skill', 'path'],
      additionalProperties: false,
    },
    catalog: {
      category: 'skills',
      exposure: 'deferred',
      summary: 'Read an active skill resource',
      keywords: ['skill', 'resource', 'reference', 'template'],
      roles: ['root', 'child'],
    },
    idempotent: true,
    execute: readSkillResource,
  },
];

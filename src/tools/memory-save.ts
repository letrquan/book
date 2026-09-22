import { basename } from 'path';
import type { ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';
import {
  MAX_BODY_CHARS,
  MEMORY_TYPES,
  type MemoryType,
  deleteMemoryEntry,
  loadMemoryContext,
  sanitizeMemoryTitle,
  saveMemory,
  shouldRejectMemoryText,
} from '../memory-store.js';
import { canonicalToolName } from './aliases.js';
import { toolFailure, toolSuccess } from './result.js';

export function hasExternalContext(context: ToolContext): boolean {
  const tools = context.usedToolNames ?? new Set(context.runtime?.toolCallStats.keys() ?? []);
  for (const name of tools) {
    const canonical = canonicalToolName(name);
    if (
      canonical === 'WebFetch' ||
      canonical === 'WebSearch' ||
      canonical.startsWith('mcp__') ||
      name.startsWith('mcp__')
    ) {
      return true;
    }
  }
  return false;
}

function fail(message: string): ToolResult {
  return toolFailure(message, { content: message });
}

export async function memorySaveExecute(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  if (context.agentConfig?.settings.memory.enabled === false) {
    return fail('Memory is disabled in settings.');
  }
  if (context.agentConfig?.settings.memory.autoSave === false) {
    return fail('Model memory writes are disabled in settings (memory.autoSave is false).');
  }

  const action = args.action;
  if (action !== 'save' && action !== 'delete') {
    return fail('Invalid action. Must be "save" or "delete".');
  }

  const workspace = context.workspaceRoot;

  if (action === 'delete') {
    if (typeof args.slug !== 'string' || !args.slug.trim()) {
      return fail('slug is required for delete action.');
    }
    const cleanSlug = basename(args.slug.trim());
    const result = deleteMemoryEntry(workspace, cleanSlug);
    if (!result.ok) {
      return fail(result.error ?? 'Failed to delete memory entry.');
    }
    return toolSuccess(`Memory deleted: ${cleanSlug}`);
  }

  // action === 'save'
  const type = args.type;
  if (typeof type !== 'string' || !MEMORY_TYPES.includes(type as MemoryType)) {
    return fail(`type is required for save action and must be one of: ${MEMORY_TYPES.join(', ')}.`);
  }

  const rawTitle = typeof args.title === 'string' ? args.title : '';
  const title = sanitizeMemoryTitle(rawTitle);
  if (!title) {
    return fail('title is required for save action and must not be empty after sanitizing.');
  }

  if (typeof args.body !== 'string' || !args.body.trim()) {
    return fail('body is required for save action.');
  }
  let body = args.body.trim();
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS);
  }

  const rejectReason = shouldRejectMemoryText(`${title}\n${body}`);
  if (rejectReason) {
    return fail(`Memory rejected: ${rejectReason}`);
  }

  const requireApproval = context.agentConfig?.settings.memory.requireApproval ?? false;
  const externalContext = hasExternalContext(context);
  const sessionId = context.sessionId;
  const slug =
    typeof args.slug === 'string' && args.slug.trim() ? basename(args.slug.trim()) : undefined;
  const supersedes =
    typeof args.supersedes === 'string' && args.supersedes.trim()
      ? basename(args.supersedes.trim())
      : undefined;

  const result = saveMemory(
    workspace,
    {
      type: type as MemoryType,
      title,
      body,
      origin: 'model-tool',
      source: 'auto',
      externalContext,
      sessionId,
      supersedes,
    },
    {
      requireApproval,
      slug,
    },
  );

  if (!result.ok) {
    return fail(result.error ?? 'Failed to save memory.');
  }

  if (result.status === 'pending') {
    const notice = `memory candidate saved: ${title} — /memory inbox`;
    context.onNotice?.(notice);
    return toolSuccess(
      `Memory candidate saved to inbox: ${result.path}\nRequires approval via /memory inbox.`,
      { data: { memorySaved: true, path: result.path, status: result.status } },
    );
  }

  try {
    if (context.agentConfig && !Object.isFrozen(context.agentConfig)) {
      context.agentConfig.memoryContext = loadMemoryContext(workspace);
    }
  } catch {
    // ignore if frozen
  }

  const notice = `memory saved: ${title}`;
  context.onNotice?.(notice);
  return toolSuccess(`Memory saved: ${result.path}\n${result.indexLine ?? ''}`.trim(), {
    data: { memorySaved: true, path: result.path, status: result.status },
  });
}

export const memorySaveTools: ToolDefinition[] = [
  {
    name: 'MemorySave',
    description:
      'Save or delete durable repository and user facts in the project memory store. Save memories when the user corrects you, says "remember", or you learn persistent project conventions. Check <memory-index> first and supply slug to update existing entries instead of duplicating. Formatting: title, then body as the fact followed by "Why:" and "How to apply:".',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'delete'],
          description:
            'The action to perform: "save" to create or update a memory, or "delete" to remove one.',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description:
            'Memory category (required for save): "user" for user preferences, "feedback" for corrections/guidance, "project" for repo-specific conventions/architecture, "reference" for pointers to key docs/resources.',
        },
        title: {
          type: 'string',
          description: 'Short title for the memory entry (required for save).',
        },
        body: {
          type: 'string',
          description:
            'Memory content formatted as the fact, followed by "Why:" and "How to apply:" (required for save).',
        },
        slug: {
          type: 'string',
          description: 'Existing memory file slug/name to update or delete.',
        },
        supersedes: {
          type: 'string',
          description: 'Optional slug of an earlier memory entry this entry replaces.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: memorySaveExecute,
  },
];

import { basename } from 'path';
import type { ToolCategory, ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';
import {
  MAX_BODY_CHARS,
  MEMORY_TYPES,
  type MemoryType,
  deleteMemoryEntry,
  isMemorySaveAvailable,
  sanitizeMemoryTitle,
  saveMemory,
  shouldRejectMemoryText,
} from '../memory-store.js';
import { canonicalToolName } from './aliases.js';
import { categoryFor } from './catalog.js';
import { toolFailure, toolSuccess } from './result.js';

/**
 * Categories whose tools return text this session did not author and cannot
 * vouch for: the web and MCP servers. Read through the catalog rather than kept
 * as a name list, so every tool of those kinds counts, now or later.
 */
const EXTERNAL_CONTEXT_CATEGORIES = new Set<ToolCategory>(['web', 'mcp']);

/**
 * The tools outside those categories that bring another agent's text into this
 * session: `Task` returns a subagent's answer; `AgentSpawn`/`AgentSend` get the
 * managed agent's result delivered back automatically; `AgentRead`/`AgentGet`/
 * `AgentWait` read it; `EvidenceList` returns evidence children published. The
 * rest of those categories is local — `Check` runs a command here, and
 * `AgentList`, `AgentStop`, `AgentPlan` report state this session owns.
 */
const AGENT_TEXT_TOOLS = new Set([
  'Task',
  'AgentSpawn',
  'AgentSend',
  'AgentRead',
  'AgentGet',
  'AgentWait',
  'EvidenceList',
]);

/** Whether a tool brings text this session did not author into the conversation. */
export function isExternalContextTool(name: string): boolean {
  const canonical = canonicalToolName(name);
  return EXTERNAL_CONTEXT_CATEGORIES.has(categoryFor(canonical)) || AGENT_TEXT_TOOLS.has(canonical);
}

export function hasExternalContext(context: ToolContext): boolean {
  const tools = context.usedToolNames ?? new Set(context.runtime?.toolCallStats.keys() ?? []);
  for (const name of tools) if (isExternalContextTool(name)) return true;
  return false;
}

function fail(message: string): ToolResult {
  return toolFailure(message, { content: message });
}

export async function memorySaveExecute(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  if (!isMemorySaveAvailable(context.agentConfig?.settings)) {
    return fail('Model memory writes are disabled in settings.');
  }

  const action = args.action;
  if (action !== 'save' && action !== 'delete') {
    return fail('Invalid action. Must be "save" or "delete".');
  }

  const workspace = context.workspaceRoot;
  const requireApproval = context.agentConfig?.settings.memory.requireApproval ?? false;
  const quarantineExternal = context.agentConfig?.settings.memory.quarantineExternal ?? true;
  const externalContext = hasExternalContext(context);

  if (action === 'delete') {
    // The model may not delete anything the user has not seen: `saveMemory` is
    // what decides whether a session's writes are quarantined, so the same
    // conditions put deletion in the user's hands.
    const quarantined = quarantineExternal && externalContext;
    if (quarantined || requireApproval) {
      return fail(
        quarantined
          ? 'this session read external content; deletion needs the user — ask them to run /memory delete'
          : 'memory.requireApproval is on; deletion needs the user — ask them to run /memory delete',
      );
    }
    if (typeof args.slug !== 'string' || !args.slug.trim()) {
      return fail('slug is required for delete action.');
    }
    const result = deleteMemoryEntry(workspace, args.slug);
    if (!result.ok || !result.path) {
      return fail(result.error ?? 'Failed to delete memory entry.');
    }
    const deleted = basename(result.path);
    context.onNotice?.(`memory deleted: ${deleted}`);
    return toolSuccess(`Memory deleted: ${deleted}`, {
      data: { action: 'delete', slug: deleted },
    });
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
  const body = args.body.trim();
  if (body.length > MAX_BODY_CHARS) {
    return fail(
      `body exceeds maximum length of ${MAX_BODY_CHARS} characters (received ${body.length}). Please shorten the content.`,
    );
  }

  const rejectReason = shouldRejectMemoryText(`${title}\n${body}`);
  if (rejectReason) {
    return fail(`Memory rejected: ${rejectReason}`);
  }

  const sessionId = context.sessionId;
  // Raw: `saveMemory` resolves and sanitizes the slug through `memoryFileForSlug`.
  const slug = typeof args.slug === 'string' && args.slug.trim() ? args.slug : undefined;

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
    },
    {
      requireApproval,
      quarantineExternal,
      slug,
    },
  );

  if (!result.ok) {
    return fail(result.error ?? 'Failed to save memory.');
  }

  if (result.status === 'pending') {
    const quarantined = result.quarantined === true;
    const notice = quarantined
      ? `memory candidate saved (this session read external content): ${title} — /memory inbox`
      : `memory candidate saved: ${title} — /memory inbox`;
    context.onNotice?.(notice);
    const message = quarantined
      ? `Memory candidate saved to inbox (this session read external content): ${result.path}\nRequires approval via /memory inbox.`
      : `Memory candidate saved to inbox: ${result.path}\nRequires approval via /memory inbox.`;
    return toolSuccess(message, {
      data: {
        memorySaved: true,
        action: 'save',
        path: result.path,
        status: result.status,
        quarantined: result.quarantined,
      },
    });
  }

  const notice = `memory saved: ${title}`;
  context.onNotice?.(notice);
  return toolSuccess(`Memory saved: ${result.path}\n${result.indexLine ?? ''}`.trim(), {
    data: {
      memorySaved: true,
      action: 'save',
      path: result.path,
      status: result.status,
    },
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
          description: `Memory content formatted as the fact, followed by "Why:" and "How to apply:" (required for save; max ${MAX_BODY_CHARS} characters).`,
        },
        slug: {
          type: 'string',
          description: 'Existing memory file slug/name to update or delete.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: memorySaveExecute,
  },
];

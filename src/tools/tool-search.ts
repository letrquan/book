import type {
  ToolCategory,
  ToolDefinition,
  ToolDiscoveryContext,
  ToolResult,
  ToolSelection,
} from '../types/tools.js';
import { toolFailure, toolSuccess } from './result.js';

function selectionLine(selection: ToolSelection): string {
  switch (selection.status) {
    case 'loaded':
      return `${selection.name} [${selection.category}${selection.namespace ? `:${selection.namespace}` : ''}] - ${selection.summary}`;
    case 'active':
      return `Already active this turn: ${selection.name}. Call it directly.`;
    case 'unknown':
      return `${selection.requested}: no tool has this name. Use the names in the deferred tool list, or search by capability.`;
    case 'ambiguous':
      return `${selection.requested}: matches more than one tool when letter case is ignored. Write the exact name.`;
    case 'unauthorized':
      return `${selection.name}: not authorized in this context (role, mode or capability rules), so it cannot be loaded.`;
    case 'budget':
      return `${selection.name}: does not fit within the configured loaded-tool and schema budgets.`;
  }
}

function selectTools(list: string, discovery: ToolDiscoveryContext): ToolResult {
  const names = list.split(/[,\s]+/).filter(Boolean);
  if (names.length === 0) {
    return toolFailure(
      'select: needs at least one tool name, for example select:WebFetch,WebSearch.',
      {
        code: 'invalid_arguments',
        remediation: 'Pass tool names after select:, separated by commas.',
      },
    );
  }
  if (!discovery.select) {
    return toolFailure('Tool discovery is unavailable in this execution context.', {
      code: 'discovery_unavailable',
    });
  }
  const selections = discovery.select(names);
  const loaded = selections.filter((selection) => selection.status === 'loaded');
  const content = selections.map(selectionLine).join('\n');
  const data = { query: `select:${names.join(',')}`, selections };
  if (loaded.length === 0 && !selections.some((selection) => selection.status === 'active')) {
    const budget = selections.some((selection) => selection.status === 'budget');
    return toolFailure(content, {
      code: budget ? 'tool_discovery_budget_exceeded' : 'tool_not_found',
      remediation: budget
        ? 'Select fewer or smaller tools, or ask the host to increase the tool discovery budget.'
        : 'Use the names in the deferred tool list, or search by capability.',
      data,
    });
  }
  return toolSuccess(content, {
    data,
    presentation: {
      kind: 'search',
      summary:
        loaded.length > 0
          ? `Loaded ${loaded.length} tool${loaded.length === 1 ? '' : 's'} for the next turn`
          : 'Already active',
      metadata: loaded.length > 0 ? [`${loaded.length} loaded`] : undefined,
    },
  });
}

export const toolSearchTools: ToolDefinition[] = [
  {
    name: 'ToolSearch',
    description:
      'Load deferred tools when the active tools do not cover the task; they become available on the next model turn. Pass "select:Name1,Name2" to load exact tools by the names the deferred tool list gives (aliases and any letter case work), or describe a capability, product, server, or action to search: a search returns at most five concise matches. Has no external side effects.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Exact tools as "select:WebFetch,WebSearch", or a specific capability to find, such as "git commit", "search Slack", or "read session history". With select:, category, namespace and limit are ignored.',
          minLength: 1,
        },
        category: {
          type: 'string',
          description: 'Optional catalog category filter.',
          enum: [
            'filesystem',
            'shell',
            'git',
            'web',
            'planning',
            'tasks',
            'skills',
            'agents',
            'evidence',
            'session',
            'notebook',
            'mcp',
            'other',
          ],
        },
        namespace: {
          type: 'string',
          description: 'Optional MCP server namespace filter, without the mcp__ prefix.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum matches to activate; defaults to five and cannot exceed five.',
          minimum: 1,
          maximum: 5,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    idempotent: true,
    catalog: {
      aliases: ['find_tools', 'search_tools'],
      keywords: ['capability', 'catalog', 'discover', 'deferred'],
      category: 'other',
      exposure: 'core',
      roles: ['root', 'child'],
      effects: ['read'],
    },
    execute: async (args, context): Promise<ToolResult> => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return toolFailure(
          'Missing required query. Describe the capability you need, for example "git history".',
          { code: 'invalid_arguments', remediation: 'Pass a specific capability in query.' },
        );
      }
      if (!context.toolDiscovery) {
        return toolFailure('Tool discovery is unavailable in this execution context.', {
          code: 'discovery_unavailable',
        });
      }
      const selected = /^select:/i.exec(query);
      if (selected) return selectTools(query.slice(selected[0].length), context.toolDiscovery);
      const matches = context.toolDiscovery.search(
        query,
        args.category as ToolCategory | undefined,
        typeof args.namespace === 'string' ? args.namespace : undefined,
        typeof args.limit === 'number' ? args.limit : undefined,
      );
      // Named on every answer, not only when nothing matched: a model that searched for a tool it
      // already has should learn that it has it rather than read a list of others.
      const active =
        context.toolDiscovery.activeMatches?.(query, {
          category: args.category as ToolCategory | undefined,
          namespace: typeof args.namespace === 'string' ? args.namespace : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        }) ?? [];
      const activated = new Set(context.toolDiscovery.activate(matches.map((match) => match.name)));
      const resolvedMatches = matches.map((match) => ({
        ...match,
        loaded: activated.has(match.name),
      }));
      const loadedMatches = resolvedMatches.filter((match) => match.loaded);
      if (matches.length === 0) {
        return toolSuccess(
          active.length > 0
            ? `No deferred tools matched: ${query}. Already active this turn, so call them directly: ${active.join(', ')}.`
            : `No authorized deferred tools matched: ${query}`,
          {
            data: { query, matches: [], active },
            presentation: {
              kind: 'search',
              summary: active.length > 0 ? 'Already active' : 'No deferred tools matched',
            },
          },
        );
      }
      if (loadedMatches.length === 0) {
        return toolFailure(
          `Matching tools could not fit within the configured loaded-tool and schema budgets: ${query}`,
          {
            code: 'tool_discovery_budget_exceeded',
            remediation:
              'Use a narrower query or ask the host to increase the tool discovery budget.',
            data: { query, matches: resolvedMatches },
          },
        );
      }
      const content =
        loadedMatches
          .map(
            (match) =>
              `${match.name} [${match.category}${match.namespace ? `:${match.namespace}` : ''}] - ${match.summary}`,
          )
          .join('\n') +
        (active.length > 0 ? `\nAlready active this turn: ${active.join(', ')}.` : '');
      return toolSuccess(content, {
        data: { query, matches: resolvedMatches, active },
        presentation: {
          kind: 'search',
          summary: `Loaded ${loadedMatches.length} tool${loadedMatches.length === 1 ? '' : 's'} for the next turn`,
          metadata: [`${loadedMatches.length} loaded`],
        },
      });
    },
  },
];

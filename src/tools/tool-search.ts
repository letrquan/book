import type { ToolCategory, ToolDefinition, ToolResult } from '../types/tools.js';
import { toolFailure, toolSuccess } from './result.js';

export const toolSearchTools: ToolDefinition[] = [
  {
    name: 'ToolSearch',
    description:
      'Search the authorized deferred tool catalog when the active tools do not cover the task. Matching tool definitions become available on the next model turn. Search by capability, product, server, or action; returns at most five concise matches and has no external side effects.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Specific capability to find, such as "git commit", "search Slack", or "read session history".',
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
      const matches = context.toolDiscovery.search(
        query,
        args.category as ToolCategory | undefined,
        typeof args.namespace === 'string' ? args.namespace : undefined,
        typeof args.limit === 'number' ? args.limit : undefined,
      );
      const activated = new Set(context.toolDiscovery.activate(matches.map((match) => match.name)));
      const resolvedMatches = matches.map((match) => ({
        ...match,
        loaded: activated.has(match.name),
      }));
      const loadedMatches = resolvedMatches.filter((match) => match.loaded);
      if (matches.length === 0) {
        return toolSuccess(`No authorized deferred tools matched: ${query}`, {
          data: { query, matches: [] },
          presentation: { kind: 'search', summary: 'No deferred tools matched' },
        });
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
      const content = loadedMatches
        .map(
          (match) =>
            `${match.name} [${match.category}${match.namespace ? `:${match.namespace}` : ''}] - ${match.summary}`,
        )
        .join('\n');
      return toolSuccess(content, {
        data: { query, matches: resolvedMatches },
        presentation: {
          kind: 'search',
          summary: `Loaded ${loadedMatches.length} tool${loadedMatches.length === 1 ? '' : 's'} for the next turn`,
          metadata: [`${loadedMatches.length} loaded`],
        },
      });
    },
  },
];

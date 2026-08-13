import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBookHome } from '../book-home.js';
import { evaluateMcpServerApproval } from '../mcp-approvals.js';
import {
  formatMcpServerCommand,
  isValidMcpServerName,
  resolveMcpServerList,
  type McpServerConfig,
  type McpServerSource,
  type McpTransportType,
} from '../mcp-config.js';
import { resolveSettings } from '../settings-loader.js';
import { writeFileAtomic } from '../settings-repository.js';

export type McpConfigScope = 'user' | 'project';

export interface McpCommandOptions {
  workspace: string;
  json?: boolean;
  /** System-home override used by tests, matching resolveMcpServerList's `home` option. */
  home?: string;
}

export interface McpAddCommandOptions extends McpCommandOptions {
  scope?: McpConfigScope;
  transport?: McpTransportType;
  env?: string[];
  header?: string[];
  cwd?: string;
  force?: boolean;
}

export interface McpRemoveCommandOptions extends McpCommandOptions {
  scope?: McpConfigScope;
}

interface McpConfigDocument extends Record<string, unknown> {
  mcpServers?: Record<string, unknown>;
}

interface McpCliServerRecord {
  name: string;
  source: McpServerSource;
  path: string;
  transport: McpTransportType;
  target: string;
  approval: 'user' | 'approved' | 'rejected' | 'unknown';
  envKeys: string[];
  headerKeys: string[];
}

function configPath(workspace: string, scope: McpConfigScope, home?: string): string {
  return scope === 'project'
    ? join(workspace, '.mcp.json')
    : home
      ? join(home, '.book', 'mcp.json')
      : join(resolveBookHome(), 'mcp.json');
}

function validScope(scope: string | undefined): McpConfigScope {
  const normalized = scope ?? 'user';
  if (normalized !== 'user' && normalized !== 'project') {
    throw new Error('MCP scope must be "user" or "project".');
  }
  return normalized;
}

function readConfigDocument(path: string): McpConfigDocument {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot update ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Cannot update ${path}: expected a JSON object.`);
  }
  const document = parsed as McpConfigDocument;
  if (
    document.mcpServers !== undefined &&
    (!document.mcpServers ||
      typeof document.mcpServers !== 'object' ||
      Array.isArray(document.mcpServers))
  ) {
    throw new Error(`Cannot update ${path}: mcpServers must be an object.`);
  }
  return document;
}

function parseEntries(kind: 'env' | 'header', entries: string[] = []): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new Error(`Invalid --${kind} value "${entry}"; expected KEY=VALUE.`);
    const key = entry.slice(0, separator).trim();
    if (!key) throw new Error(`Invalid --${kind} value "${entry}"; the key is empty.`);
    parsed[key] = entry.slice(separator + 1);
  }
  return parsed;
}

function validateRemoteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Remote MCP URL must be an absolute http:// or https:// URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Remote MCP URL must use http:// or https://.');
  }
  if (url.username || url.password) throw new Error('Remote MCP URL must not contain credentials.');
  return raw;
}

function inferredTransport(target: string, requested?: McpTransportType): McpTransportType {
  if (requested) {
    if (!['stdio', 'http', 'sse'].includes(requested)) {
      throw new Error('MCP transport must be "stdio", "http", or "sse".');
    }
    return requested;
  }
  return /^https?:\/\//i.test(target) ? 'http' : 'stdio';
}

function createServerConfig(
  target: string,
  serverArgs: string[],
  options: McpAddCommandOptions,
): McpServerConfig {
  const transport = inferredTransport(target, options.transport);
  if (transport === 'stdio') {
    if (!target.trim()) throw new Error('Stdio MCP command must not be empty.');
    if ((options.header?.length ?? 0) > 0) {
      throw new Error('--header is available only for HTTP/SSE servers.');
    }
    return {
      type: 'stdio',
      command: target,
      args: serverArgs,
      env: parseEntries('env', options.env),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    };
  }
  if (serverArgs.length > 0)
    throw new Error('HTTP/SSE MCP servers do not accept command arguments.');
  if ((options.env?.length ?? 0) > 0 || options.cwd) {
    throw new Error('--env and --cwd are available only for stdio servers.');
  }
  return {
    type: transport,
    url: validateRemoteUrl(target),
    headers: parseEntries('header', options.header),
  };
}

function writeServer(
  workspace: string,
  scope: McpConfigScope,
  name: string,
  config: McpServerConfig,
  force: boolean,
  home?: string,
): string {
  const path = configPath(workspace, scope, home);
  const document = readConfigDocument(path);
  const servers = { ...(document.mcpServers ?? {}) };
  if (Object.prototype.hasOwnProperty.call(servers, name) && !force) {
    throw new Error(`MCP server "${name}" already exists in ${path}; pass --force to replace it.`);
  }
  servers[name] = config;
  writeFileAtomic(path, JSON.stringify({ ...document, mcpServers: servers }, null, 2) + '\n');
  return path;
}

function removeServer(
  workspace: string,
  scope: McpConfigScope,
  name: string,
  home?: string,
): string {
  const path = configPath(workspace, scope, home);
  const document = readConfigDocument(path);
  const servers = { ...(document.mcpServers ?? {}) };
  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    throw new Error(`MCP server "${name}" is not declared in ${path}.`);
  }
  delete servers[name];
  writeFileAtomic(path, JSON.stringify({ ...document, mcpServers: servers }, null, 2) + '\n');
  return path;
}

function serverRecords(workspace: string, home?: string): McpCliServerRecord[] {
  const settings = resolveSettings(workspace);
  return resolveMcpServerList(workspace, { home }).map((server) => ({
    name: server.name,
    source: server.source,
    path: server.path,
    transport: server.config.type ?? (server.config.url ? 'http' : 'stdio'),
    target: formatMcpServerCommand(server.config),
    approval: server.source === 'user' ? 'user' : evaluateMcpServerApproval(settings, server),
    envKeys: Object.keys(server.config.env ?? {}).sort(),
    headerKeys: Object.keys(server.config.headers ?? {}).sort(),
  }));
}

function printRecords(records: McpCliServerRecord[], json = false): void {
  if (json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }
  if (records.length === 0) {
    console.log('No MCP servers configured.');
    return;
  }
  for (const server of records) {
    console.log(
      `${server.name}: ${server.target} [${server.source}${server.source === 'project' ? `: ${server.approval}` : ''}]`,
    );
    if (server.envKeys.length > 0) console.log(`  env: ${server.envKeys.join(', ')}`);
    if (server.headerKeys.length > 0) {
      console.log(`  headers: ${server.headerKeys.join(', ')} (values hidden)`);
    }
    console.log(`  config: ${server.path}`);
  }
}

export function runMcpListCommand(options: McpCommandOptions): void {
  printRecords(serverRecords(options.workspace, options.home), options.json);
}

export function runMcpGetCommand(name: string, options: McpCommandOptions): void {
  const server = serverRecords(options.workspace, options.home).find(
    (candidate) => candidate.name === name,
  );
  if (!server) throw new Error(`MCP server "${name}" is not configured.`);
  printRecords([server], options.json);
}

export function runMcpAddCommand(
  name: string,
  target: string,
  serverArgs: string[],
  options: McpAddCommandOptions,
): void {
  if (!isValidMcpServerName(name)) {
    throw new Error(
      'MCP server names may contain letters, numbers, hyphens, or underscores, but not a double underscore.',
    );
  }
  const scope = validScope(options.scope);
  const config = createServerConfig(target, serverArgs, options);
  const path = writeServer(
    options.workspace,
    scope,
    name,
    config,
    options.force ?? false,
    options.home,
  );
  console.log(`Added MCP server "${name}" to ${path}.`);
  if (scope === 'project') {
    console.log('Project servers require one-time approval in an interactive Book session.');
  }
}

export function runMcpRemoveCommand(name: string, options: McpRemoveCommandOptions): void {
  const scope = options.scope
    ? validScope(options.scope)
    : serverRecords(options.workspace, options.home).find((candidate) => candidate.name === name)
        ?.source;
  if (!scope) throw new Error(`MCP server "${name}" is not configured.`);
  const path = removeServer(options.workspace, scope, name, options.home);
  console.log(`Removed MCP server "${name}" from ${path}.`);
}

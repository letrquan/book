import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { resolveBookHome } from './book-home.js';

export type McpTransportType = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  /** Explicit transport. Omitted means stdio when `command` is present. */
  type?: McpTransportType;
  /** Executable for stdio servers. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Optional working directory for stdio servers. */
  cwd?: string;
  /** Endpoint for HTTP/SSE servers. */
  url?: string;
  /** Additional request headers for HTTP/SSE servers. Values are never shown in diagnostics. */
  headers?: Record<string, string>;
}

const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export function isValidMcpServerName(name: string): boolean {
  return SAFE_SERVER_NAME.test(name) && !name.includes('__');
}

interface McpConfigDocument {
  mcpServers?: Record<string, unknown>;
}

/** Where a server declaration came from; project declarations require approval. */
export type McpServerSource = 'user' | 'project';

export interface ResolvedMcpServer {
  name: string;
  config: McpServerConfig;
  source: McpServerSource;
  /** Config file that defined (or, on a name collision, last overrode) this server. */
  path: string;
}

export interface McpDiagnostic {
  level: 'warn';
  message: string;
  server?: string;
}

export type McpDiagnosticSink = (diagnostic: McpDiagnostic) => void;

/** Preserves the historical stderr warning behavior for headless/SDK hosts. */
export const consoleMcpDiagnosticSink: McpDiagnosticSink = (diagnostic) => {
  console.warn(`⚠  ${diagnostic.message}`);
};

export interface ResolveMcpServersOptions {
  home?: string;
  onDiagnostic?: McpDiagnosticSink;
  /** Environment used for `${VAR}` interpolation; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

interface ExpandedValue {
  value: string;
  missing: string[];
}

/**
 * Expand the small interpolation language used by the de-facto mcpServers
 * config format. We deliberately support only `${NAME}` and `${NAME:-default}`
 * here; shell syntax is never evaluated.
 */
function expandValue(raw: string, env: NodeJS.ProcessEnv): ExpandedValue {
  const missing = new Set<string>();
  const value = raw.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => {
      const configured = env[name];
      if (configured !== undefined) return configured;
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return '';
    },
  );
  return { value, missing: [...missing] };
}

function expandRecord(
  raw: unknown,
  env: NodeJS.ProcessEnv,
): { value: Record<string, string>; missing: string[]; invalid: string[] } {
  const value: Record<string, string> = {};
  const missing = new Set<string>();
  const invalid: string[] = [];
  if (raw === undefined) return { value, missing: [], invalid };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value, missing: [], invalid: ['expected an object'] };
  }
  for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof item !== 'string') {
      invalid.push(`${key} must be a string`);
      continue;
    }
    const expanded = expandValue(item, env);
    value[key] = expanded.value;
    for (const name of expanded.missing) missing.add(name);
  }
  return { value, missing: [...missing], invalid };
}

function normalizeServerConfig(
  name: string,
  raw: unknown,
  env: NodeJS.ProcessEnv,
): { config?: McpServerConfig; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'expected an object' };
  }
  const source = raw as Record<string, unknown>;
  const requestedType = source.type ?? source.transport;
  const type =
    requestedType === undefined
      ? source.url !== undefined
        ? 'http'
        : 'stdio'
      : String(requestedType).toLowerCase();
  if (!['stdio', 'http', 'sse'].includes(type)) {
    return { error: `unsupported transport type "${String(requestedType)}"` };
  }

  const commandExpanded =
    typeof source.command === 'string' ? expandValue(source.command, env) : undefined;
  const urlExpanded = typeof source.url === 'string' ? expandValue(source.url, env) : undefined;
  const missing = new Set([...(commandExpanded?.missing ?? []), ...(urlExpanded?.missing ?? [])]);
  const args: string[] = [];
  if (source.args !== undefined) {
    if (!Array.isArray(source.args)) return { error: 'args must be an array' };
    for (const [index, item] of source.args.entries()) {
      if (typeof item !== 'string') return { error: `args[${index}] must be a string` };
      const expanded = expandValue(item, env);
      args.push(expanded.value);
      for (const variable of expanded.missing) missing.add(variable);
    }
  }
  const envValues = expandRecord(source.env, env);
  const headerValues = expandRecord(source.headers, env);
  for (const variable of [...envValues.missing, ...headerValues.missing]) missing.add(variable);
  if (envValues.invalid.length > 0) return { error: `env ${envValues.invalid.join(', ')}` };
  if (headerValues.invalid.length > 0)
    return { error: `headers ${headerValues.invalid.join(', ')}` };
  if (missing.size > 0)
    return { error: `missing environment variable(s): ${[...missing].join(', ')}` };

  if (type === 'stdio') {
    if (!commandExpanded?.value.trim())
      return { error: 'stdio server requires a non-empty command' };
    const cwd = typeof source.cwd === 'string' ? expandValue(source.cwd, env) : undefined;
    if (cwd?.missing.length)
      return { error: `missing environment variable(s): ${cwd.missing.join(', ')}` };
    return {
      config: {
        type: 'stdio',
        command: commandExpanded.value,
        args,
        env: envValues.value,
        ...(cwd?.value ? { cwd: cwd.value } : {}),
      },
    };
  }

  if (!urlExpanded?.value.trim()) return { error: `${type} server requires a non-empty url` };
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlExpanded.value);
  } catch {
    return { error: 'url must be a valid absolute URL' };
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { error: 'url must use http:// or https://' };
  }
  if (parsedUrl.username || parsedUrl.password)
    return { error: 'url must not contain credentials' };
  return {
    config: {
      type: type as 'http' | 'sse',
      url: parsedUrl.toString(),
      headers: headerValues.value,
    },
  };
}

/**
 * Resolve the declared MCP servers with provenance.
 *
 * Sources, later wins on a name collision: <BOOK_HOME>/.book/mcp.json (user),
 * then <workspace>/.mcp.json (project). A project entry that overrides a
 * user-global name keeps `source: 'project'` so it cannot inherit the trust of
 * the name it shadows.
 */
export function resolveMcpServerList(
  workspace: string,
  options: ResolveMcpServersOptions = {},
): ResolvedMcpServer[] {
  const onDiagnostic = options.onDiagnostic ?? consoleMcpDiagnosticSink;
  const env = options.env ?? process.env;
  const bookHome = options.home ? join(options.home, '.book') : resolveBookHome();
  const sources: Array<{ path: string; source: McpServerSource }> = [
    { path: join(bookHome, 'mcp.json'), source: 'user' },
    { path: join(workspace, '.mcp.json'), source: 'project' },
  ];
  const servers = new Map<string, ResolvedMcpServer>();

  for (const { path, source } of sources) {
    if (!existsSync(path)) continue;
    let parsed: McpConfigDocument;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as McpConfigDocument;
    } catch {
      onDiagnostic({ level: 'warn', message: `Failed to load MCP config: ${path}` });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers) continue;
    if (typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) {
      onDiagnostic({ level: 'warn', message: `Invalid mcpServers object: ${path}` });
      continue;
    }
    for (const [name, rawConfig] of Object.entries(parsed.mcpServers)) {
      if (!isValidMcpServerName(name)) {
        onDiagnostic({
          level: 'warn',
          message: `Ignoring invalid MCP server name: ${name} (${path}); use letters, numbers, hyphens, or underscores, without a double underscore`,
          server: name,
        });
        continue;
      }
      const normalized = normalizeServerConfig(name, rawConfig, env);
      if (!normalized.config) {
        onDiagnostic({
          level: 'warn',
          message: `Ignoring invalid MCP server config: ${name} (${path}): ${normalized.error ?? 'invalid configuration'}`,
          server: name,
        });
        continue;
      }
      servers.set(name, {
        name,
        source,
        path,
        config: normalized.config,
      });
    }
  }

  return [...servers.values()];
}

/** Merged name → config view used by doctor and ambient-run fingerprinting. */
export function loadMcpConfig(workspace: string, home?: string): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const server of resolveMcpServerList(workspace, { home })) {
    servers[server.name] = server.config;
  }
  return servers;
}

/** Render one server as the exact command line a host is being asked to trust. */
export function formatMcpServerCommand(config: McpServerConfig): string {
  const sensitiveValues = [
    ...Object.values(config.env ?? {}),
    ...Object.values(config.headers ?? {}),
  ]
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
  const redact = (value: string): string => {
    let rendered = value;
    for (const sensitive of sensitiveValues)
      rendered = rendered.replaceAll(sensitive, '<redacted>');
    return rendered;
  };
  if (config.type === 'http' || config.type === 'sse' || (!config.command && config.url)) {
    const headers = Object.keys(config.headers ?? {}).sort();
    let endpoint = config.url ?? '';
    let queryConfigured = false;
    try {
      const url = new URL(endpoint);
      queryConfigured = Boolean(url.search);
      url.search = '';
      url.hash = '';
      endpoint = url.toString();
    } catch {
      endpoint = redact(endpoint);
    }
    const metadata = [
      ...(queryConfigured ? ['query configured'] : []),
      ...(headers.length ? [`headers: ${headers.join(', ')}`] : []),
    ];
    return `${config.type === 'sse' ? 'sse' : 'http'} ${endpoint}${metadata.length ? ` (${metadata.join('; ')})` : ''}`;
  }
  return [config.command ?? '', ...(config.args ?? [])].filter(Boolean).map(redact).join(' ');
}

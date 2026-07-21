import type {
  ToolResult,
  ToolResultArtifacts,
  ToolResultError,
  ToolResultPresentation,
  ToolResultStatus,
} from '../types.js';
import { canonicalToolName } from './aliases.js';
import { getPrimaryArg } from './primary-arg.js';
import { isFileMutatingTool } from './tool-capabilities.js';

interface ToolResultOptions<TData> {
  toolCallId?: string;
  data?: TData;
  presentation?: Partial<ToolResultPresentation>;
  artifacts?: ToolResultArtifacts;
  pagination?: ToolResult['pagination'];
}

interface LegacyToolResult {
  version?: 2;
  toolCallId: string;
  status?: ToolResultStatus;
  content?: string;
  output?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
  structuredError?: ToolResultError;
  presentation?: ToolResultPresentation;
  metrics?: ToolResult['metrics'];
  artifacts?: ToolResultArtifacts;
  durationMs?: number;
  retryAttempt?: number;
  fileMutation?: ToolResultArtifacts['fileMutation'];
  fileObservations?: ToolResultArtifacts['fileObservations'];
  eventRef?: string;
  pagination?: ToolResult['pagination'];
}

function presentationFor(
  content: string,
  override?: Partial<ToolResultPresentation>,
): ToolResultPresentation {
  return {
    kind: override?.kind ?? 'text',
    summary: override?.summary ?? content.split('\n')[0]?.trim() ?? '',
    details: override?.details ?? content,
    metadata: override?.metadata,
    target: override?.target,
  };
}

export function toolSuccess<TData = unknown>(
  content: string,
  options: ToolResultOptions<TData> = {},
): ToolResult<TData> {
  return {
    version: 2,
    toolCallId: options.toolCallId ?? '',
    status: 'success',
    content,
    data: options.data,
    presentation: options.presentation ? presentationFor(content, options.presentation) : undefined,
    artifacts: options.artifacts,
    pagination: options.pagination,
  };
}

export function toolFailure(
  message: string,
  options: ToolResultOptions<unknown> & {
    code?: string;
    status?: Exclude<ToolResultStatus, 'success'>;
    retryable?: boolean;
    remediation?: string;
    details?: Record<string, unknown>;
    content?: string;
  } = {},
): ToolResult {
  const error: ToolResultError = {
    code: options.code ?? 'tool_error',
    message,
    retryable: options.retryable ?? false,
    remediation: options.remediation,
    details: options.details,
  };
  const content = options.content ?? '';
  return {
    version: 2,
    toolCallId: options.toolCallId ?? '',
    status: options.status ?? 'error',
    content,
    data: options.data,
    structuredError: error,
    presentation: options.presentation
      ? presentationFor(message, {
          summary: message.split('\n')[0]?.trim(),
          details: message,
          ...options.presentation,
        })
      : undefined,
    artifacts: options.artifacts,
    pagination: options.pagination,
  };
}

export function toolResultSucceeded(result: ToolResult): boolean {
  return result.status === 'success';
}

export function toolResultErrorMessage(result: ToolResult): string | undefined {
  return result.structuredError?.message;
}

export function toolResultModelContent(result: ToolResult): string {
  const content = result.content;
  if (toolResultSucceeded(result)) return content;
  const detail = content ? `\n${content}` : '';
  return `ERROR [${result.structuredError?.code ?? result.status}]: ${toolResultErrorMessage(result) ?? 'tool failed'}${detail}`;
}

export function replaceToolResult(
  result: ToolResult,
  patch: {
    status?: ToolResultStatus;
    content?: string;
    error?: ToolResultError;
    presentation?: Partial<ToolResultPresentation>;
  },
): ToolResult {
  const status = patch.status ?? result.status;
  const content = patch.content ?? result.content;
  return {
    ...result,
    status,
    content,
    structuredError: patch.error ?? (status === 'success' ? undefined : result.structuredError),
    presentation:
      result.presentation || patch.presentation
        ? presentationFor(content, {
            ...result.presentation,
            ...patch.presentation,
          })
        : undefined,
  };
}

/** Upgrade persisted pre-V2 results while keeping the runtime and SDK contract V2-only. */
export function normalizeToolResult(result: ToolResult | LegacyToolResult): ToolResult {
  const legacy = result as LegacyToolResult;
  const legacySuccess = legacy.success;
  const legacyError = typeof legacy.error === 'string' ? legacy.error : undefined;
  const status: ToolResultStatus = result.status
    ? result.status
    : legacySuccess
      ? 'success'
      : legacyError?.startsWith('SKIPPED')
        ? 'blocked'
        : legacyError?.startsWith('CANCELLED')
          ? 'cancelled'
          : legacyError?.startsWith('Tool timeout')
            ? 'timed_out'
            : 'error';
  const content = result.content ?? legacy.output ?? '';
  const error =
    status === 'success'
      ? undefined
      : {
          ...(result.structuredError ?? {}),
          code: result.structuredError?.code ?? (status === 'blocked' ? 'blocked' : status),
          message: legacyError ?? result.structuredError?.message ?? 'Tool failed',
          retryable: result.structuredError?.retryable ?? status === 'timed_out',
        };
  const artifacts: ToolResultArtifacts | undefined =
    result.artifacts ??
    (legacy.fileMutation || legacy.fileObservations || legacy.eventRef
      ? {
          fileMutation: legacy.fileMutation,
          fileObservations: legacy.fileObservations,
          eventRef: legacy.eventRef,
        }
      : undefined);
  const metrics =
    result.metrics ??
    (legacy.durationMs !== undefined || legacy.retryAttempt !== undefined
      ? { durationMs: legacy.durationMs, retryAttempt: legacy.retryAttempt }
      : undefined);
  return {
    version: 2,
    toolCallId: result.toolCallId,
    status,
    content,
    data: result.data,
    structuredError: error,
    presentation: result.presentation,
    artifacts,
    metrics,
    pagination: result.pagination,
  };
}

function nonEmptyLines(content: string): number {
  return content.split('\n').filter((line) => line.trim()).length;
}

/** Attach stable UI data while execution still has the tool name and arguments. */
export function enrichToolResultPresentation(
  input: ToolResult,
  toolName: string,
  args: Record<string, unknown>,
): ToolResult {
  const result = normalizeToolResult(input);
  const name = canonicalToolName(toolName);
  const content = result.content;
  const explicitPresentation = result.presentation;
  const target = explicitPresentation?.target ?? (getPrimaryArg(args) || undefined);
  const metadata: string[] = explicitPresentation?.metadata
    ? [...explicitPresentation.metadata]
    : [];
  const inferKind = explicitPresentation?.kind === undefined;
  const inferSummary = explicitPresentation?.summary === undefined;
  const inferMetadata = explicitPresentation?.metadata === undefined;
  let kind: ToolResultPresentation['kind'] = explicitPresentation?.kind ?? 'text';
  let summary = explicitPresentation?.summary ?? content.split('\n')[0]?.trim() ?? '';

  if (isFileMutatingTool(name)) {
    if (inferKind) {
      kind = result.artifacts?.fileMutation ? 'file' : /^@@/m.test(content) ? 'diff' : 'file';
    }
    const mutation = result.artifacts?.fileMutation;
    if (mutation) {
      if (inferMetadata) {
        if (mutation.addedLines) metadata.push(`+${mutation.addedLines}`);
        if (mutation.removedLines) metadata.push(`-${mutation.removedLines}`);
        if (!mutation.addedLines && !mutation.removedLines) metadata.push('no changes');
      }
      if (inferSummary) {
        summary = `${mutation.kind === 'create' ? 'Created' : 'Updated'} ${mutation.filePath}`;
      }
    }
  } else if (name === 'Read') {
    if (inferKind) kind = 'file';
    const lines = content ? content.split('\n').length : 0;
    if (inferMetadata) metadata.push(lines === 1 ? '1 line' : `${lines} lines`);
    if (inferSummary) summary = target ? `Read ${target}` : summary;
  } else if (name === 'Glob') {
    if (inferKind) kind = 'search';
    const count = /^(?:No files found|No matches found)$/i.test(content.trim())
      ? 0
      : nonEmptyLines(content.replace(/\n\.\.\. \(truncated[\s\S]*$/, ''));
    if (inferMetadata) metadata.push(`${count} ${count === 1 ? 'file' : 'files'}`);
    if (inferSummary) summary = `Found ${count} ${count === 1 ? 'file' : 'files'}`;
  } else if (name === 'Grep') {
    if (inferKind) kind = 'search';
    const count = /^No matches found$/i.test(content.trim())
      ? 0
      : content.split('\n').filter((line) => /:\d+:/.test(line)).length || nonEmptyLines(content);
    if (inferMetadata) metadata.push(`${count} ${count === 1 ? 'match' : 'matches'}`);
    if (inferSummary) summary = `Found ${count} ${count === 1 ? 'match' : 'matches'}`;
  } else if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') {
    if (inferKind) kind = 'command';
    if (inferSummary) summary = target ? `${name}: ${target}` : summary;
  } else if (name === 'GitDiff') {
    if (inferKind) kind = 'diff';
  } else if (name.startsWith('Web') || name === 'ToolSearch' || name.startsWith('SessionHistory')) {
    if (inferKind) kind = name === 'ToolSearch' ? 'search' : 'markdown';
  } else if (name.startsWith('Task') || name === 'TodoWrite') {
    if (inferKind) kind = 'task';
  } else if (name.startsWith('Agent') || name.startsWith('Evidence')) {
    if (inferKind) kind = 'agent';
  }

  return {
    ...result,
    presentation: {
      kind,
      summary,
      details: explicitPresentation?.details ?? content,
      metadata,
      target: explicitPresentation?.target ?? result.artifacts?.fileMutation?.filePath ?? target,
    },
  };
}

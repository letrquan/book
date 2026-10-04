import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ToolResult,
  ToolResultArtifacts,
  ToolResultError,
  ToolResultPresentation,
  ToolResultStatus,
} from '../types/tools.js';
import { canonicalToolName } from './aliases.js';
import { getPrimaryArg } from './primary-arg.js';
import { isFileMutatingTool } from './tool-capabilities.js';
import { resolveBookHome } from '../book-home.js';

export const TOOL_RESULT_MAX_BYTES = 50 * 1024;
/**
 * What `Read` returns for a file with no lines in it. It lives here because the
 * row a transcript draws for a Read is reconstructed from its text as well as
 * from Read's own metadata, and both have to agree on these words.
 */
export const READ_EMPTY_FILE_NOTICE = '[Empty file: 0 lines.]';
/**
 * Where clipped tool output is saved in full. The loop lets `Read` open each file
 * it clipped a result into, never the whole directory.
 */
const TOOL_OUTPUT_DIRECTORY = join(resolveBookHome(), 'tool-output');

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
  fileMutations?: ToolResultArtifacts['fileMutations'];
  fileObservations?: ToolResultArtifacts['fileObservations'];
  eventRef?: string;
  outputPath?: string;
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

function rawToolResultModelContent(result: ToolResult): string {
  const content = result.content;
  if (toolResultSucceeded(result)) {
    return content.trim().length === 0 ? '(no output)' : content;
  }
  const remediation = result.structuredError?.remediation;
  const fix = remediation ? `\nFix: ${remediation}` : '';
  const detail = content ? `\n${content}` : '';
  return `ERROR [${result.structuredError?.code ?? result.status}]: ${toolResultErrorMessage(result) ?? 'tool failed'}${fix}${detail}`;
}

export function toolResultModelContent(result: ToolResult): string {
  if (result.maskedPlaceholder !== undefined) return result.maskedPlaceholder;
  const raw = rawToolResultModelContent(result);
  if (Buffer.byteLength(raw) <= TOOL_RESULT_MAX_BYTES) return raw;
  // Reached only by callers that skipped `boundToolResultOutput`, which is
  // where an agent-loop result is clipped. Both places clip a failure to its
  // head and its tail, through the same helper.
  if (!toolResultSucceeded(result)) {
    const prefix = `ERROR [${result.structuredError?.code ?? result.status}]: `;
    const fix = result.structuredError?.remediation
      ? `\nFix: ${result.structuredError.remediation}`
      : '';
    const budget = Math.max(
      1,
      TOOL_RESULT_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(fix),
    );
    return `${prefix}${headTailPreview(failureText(result), result.artifacts?.outputPath, budget)}${fix}`;
  }
  return clippedOutputPreview(raw, result.artifacts?.outputPath, TOOL_RESULT_MAX_BYTES);
}

export function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  return bytes
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}

function utf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  // Advance past any continuation bytes so the tail starts on a character
  // boundary. Cutting inside a 4-byte sequence otherwise strands three
  // continuation bytes, each of which decodes to its own replacement char.
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

/**
 * How much of a clipped failure's head survives: at most 8 KB, and never more
 * than a fifth of the budget, so the tail always has room to be worth keeping.
 */
const FAILURE_HEAD_MAX_BYTES = 8 * 1024;

/** A failure's message and its output, as the two are read when the pair is clipped. */
function failureText(result: ToolResult): string {
  const message = toolResultErrorMessage(result) ?? 'tool failed';
  return result.content ? `${message}\n${result.content}` : message;
}

/**
 * A failure is judged on both ends, so a clipped one keeps both. The head
 * carries the error line, whatever framed the output — the Task tool's
 * `Partial result (the child was stopped; nothing below is final):` — and the
 * first diagnostics. The tail carries the verdict a test runner prints last.
 * Clipping to one end loses the other: a non-zero exit puts all of stderr in
 * the message and stdout in the content, and the summary is in the stdout, so a
 * tail-only clip of a large stderr reported the head instead of the verdict
 * (#308).
 */
function headTailPreview(text: string, outputPath: string | undefined, maxBytes: number): string {
  const totalBytes = Buffer.byteLength(text);
  const headWindow = Math.min(FAILURE_HEAD_MAX_BYTES, Math.floor(maxBytes * 0.2));
  const window = utf8Prefix(text, headWindow);
  if (Buffer.byteLength(window) >= totalBytes) return text;
  // End the head on a whole line when one falls inside the kept window; a
  // half-line of output is harder to read than one line fewer.
  const lastBreak = window.lastIndexOf('\n');
  const head = lastBreak >= 0 ? window.slice(0, lastBreak + 1) : window;
  // The newline that closed that line is not shown — the one that follows the
  // head here is a joiner — so it is part of what the notice has to count.
  const headShown = head.trimEnd();
  const headBytes = Buffer.byteLength(headShown);
  const omittedNotice = (omitted: number): string =>
    outputPath
      ? `[... ${omitted} bytes omitted. Full output: ${outputPath}]`
      : `[... ${omitted} bytes omitted. Full output unavailable.]`;
  // How much sits between the head and the tail is not known until the tail is,
  // but the notice's own width is: the widest count is the whole text, so that
  // notice is the room reserved before the tail is measured. The two newlines
  // that join the three parts are reserved with it, so the result stays inside
  // the budget the caller treats as final.
  const reserve = Buffer.byteLength(omittedNotice(totalBytes)) + 2;
  const tailRoom = maxBytes - headBytes - reserve;
  if (tailRoom <= 0) return [headShown, omittedNotice(totalBytes - headBytes)].join('\n');
  // `utf8Suffix` lands on a character boundary; skip the rest of the line it
  // landed in so the tail starts on a line of its own.
  const tailWindow = utf8Suffix(text, tailRoom);
  const breakAt = tailWindow.indexOf('\n');
  const tail = breakAt >= 0 ? tailWindow.slice(breakAt + 1) : tailWindow;
  const notice = omittedNotice(totalBytes - headBytes - Buffer.byteLength(tail));
  return [headShown, notice, tail].join('\n');
}

function clippedOutputPreview(
  content: string,
  outputPath: string | undefined,
  maxBytes: number,
): string {
  const notice = outputPath
    ? `\n\n[Output truncated at ${maxBytes} bytes. Full output: ${outputPath}]`
    : `\n\n[Output truncated at ${maxBytes} bytes. Full output unavailable.]`;
  const previewBudget = Math.max(0, maxBytes - Buffer.byteLength(notice));
  return `${utf8Prefix(content, previewBudget).trimEnd()}${notice}`;
}

/**
 * Bound every provider-facing tool result at the execution boundary. Complete output is stored in
 * Book's user-local data directory when possible, never in the tracked workspace.
 */
export async function boundToolResultOutput(
  input: ToolResult,
  _workspaceRoot: string,
  maxBytes = TOOL_RESULT_MAX_BYTES,
  artifactRoot = TOOL_OUTPUT_DIRECTORY,
): Promise<ToolResult> {
  const result = normalizeToolResult(input);
  const modelContent = rawToolResultModelContent(result);
  const modelContentBytes = Buffer.byteLength(modelContent);
  const contentBytes = Buffer.byteLength(result.content);
  const details = result.presentation?.details;
  const detailsBytes = details === undefined ? 0 : Buffer.byteLength(details);
  if (modelContentBytes <= maxBytes && detailsBytes <= maxBytes) return result;

  let outputPath = result.artifacts?.outputPath;
  if (!outputPath) {
    const outputFile = join(artifactRoot, `${crypto.randomUUID()}.txt`);
    try {
      await mkdir(dirname(outputFile), { recursive: true });
      await writeFile(
        outputFile,
        detailsBytes > modelContentBytes && details ? details : modelContent,
        'utf8',
      );
      outputPath = outputFile.replace(/\\/g, '/');
    } catch {
      // Clipping must still succeed in read-only or otherwise restricted environments.
    }
  }

  const modelOverflow = modelContentBytes > maxBytes;
  const content = toolResultSucceeded(result)
    ? contentBytes > maxBytes
      ? clippedOutputPreview(result.content, outputPath, maxBytes)
      : result.content
    : modelOverflow
      ? ''
      : result.content;
  const errorPrefix = `ERROR [${result.structuredError?.code ?? result.status}]: `;
  // Reserve room for the "\nFix: <remediation>" line appended at render time so
  // the remediation survives instead of being re-clipped off the tail.
  const fixReserve = result.structuredError?.remediation
    ? Buffer.byteLength(`\nFix: ${result.structuredError.remediation}`)
    : 0;
  const errorBudget = Math.max(1, maxBytes - Buffer.byteLength(errorPrefix) - fixReserve);
  const structuredError = result.structuredError
    ? {
        ...result.structuredError,
        // The message and the output are clipped as one text, so a failure
        // keeps both ends: the error line and any framing at the top, and the
        // verdict at the bottom. The room the `Fix:` line needs is reserved
        // above, so the remediation is never what gets clipped.
        message: modelOverflow
          ? headTailPreview(failureText(result), outputPath, errorBudget)
          : result.structuredError.message,
      }
    : result.structuredError;
  const clippedDetails = details
    ? detailsBytes > maxBytes
      ? // The transcript row reads the same way the model does: a failure's
        // head and tail, not one end of it — the same reason as above.
        toolResultSucceeded(result)
        ? clippedOutputPreview(details, outputPath, maxBytes)
        : headTailPreview(details, outputPath, maxBytes)
      : details
    : toolResultSucceeded(result)
      ? content
      : structuredError?.message;

  return {
    ...result,
    content,
    structuredError,
    presentation: result.presentation
      ? { ...result.presentation, details: clippedDetails }
      : result.presentation,
    artifacts: outputPath ? { ...result.artifacts, outputPath } : result.artifacts,
    pagination: {
      ...result.pagination,
      truncated: true,
      omittedBytes: Math.max(
        result.pagination?.omittedBytes ?? 0,
        Math.max(modelContentBytes, contentBytes, detailsBytes) - maxBytes,
      ),
    },
  };
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
    // New content replaces what the model read: a placeholder standing in for
    // the previous text would hide the rewrite (a PostToolUse hook's
    // `modifiedOutput`, the plan-approval note) behind the line the tool wrote.
    ...(patch.content !== undefined ? { maskedPlaceholder: undefined } : {}),
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
    (legacy.fileMutation ||
    legacy.fileMutations ||
    legacy.fileObservations ||
    legacy.eventRef ||
    legacy.outputPath
      ? {
          fileMutation: legacy.fileMutation,
          fileMutations: legacy.fileMutations,
          fileObservations: legacy.fileObservations,
          eventRef: legacy.eventRef,
          outputPath: legacy.outputPath,
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
    // Masking's placeholder survives a resume, or a restored compaction's tail
    // would come back at full size.
    ...('maskedPlaceholder' in result && result.maskedPlaceholder !== undefined
      ? { maskedPlaceholder: result.maskedPlaceholder }
      : {}),
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

/** A Read row's line metadata: how many lines of the file, and their range when the read started partway in. */
export function readLineMetadata(start: number, count: number): string[] {
  // A row counts whole lines: the values reach this from Read's own floor and
  // from a page reconstructed out of its text, and either can be fractional.
  const first = Math.max(1, Math.floor(start));
  const lines = Math.max(0, Math.floor(count));
  if (lines <= 0) return ['empty'];
  const size = lines === 1 ? '1 line' : `${lines} lines`;
  // `121 lines · 1-121` says the same thing twice. The range earns its place only when the read
  // started partway into the file.
  return first > 1 ? [size, `${first}-${first + lines - 1}`] : [size];
}

/**
 * A Read row's metadata reconstructed from its text, for results that carry none (outlines, and
 * results persisted before tool results had a presentation): the lines of the file it returned
 * and their range, or how many declarations an outline listed. A read that stops early ends with
 * a notice (`[Lines 3-6 of 20 shown. …]`, `[Line 1 (60000 bytes) was cut …]`), which is not a
 * line of the file, and an empty file is nothing but its notice. Read's own results carry exact
 * metadata (readLineMetadata). Without Read's own count, a result persisted by a build that
 * numbered the empty element after a final newline still reads one line long, so a trailing
 * `N: ` is read past — a file ending in a blank line now returns the same text, and its phantom
 * line is gone.
 */
export function readResultMetadata(args: Record<string, unknown>, content: string): string[] {
  // An outline lists declarations under a header, not lines of the file.
  if (args.outline === true) {
    const entries = content.split('\n').filter((line) => /^\d+: /.test(line)).length;
    return ['outline', entries === 1 ? '1 entry' : `${entries} entries`];
  }
  let body =
    content === READ_EMPTY_FILE_NOTICE ? '' : content.replace(/\n\[Lines? \d[^\n]*\]$/, '');
  if (body === content) body = body.replace(/(?:^|\n)\d+: $/, '');
  const lineCount = body ? body.split('\n').length : 0;
  const offset = Number(args.offset ?? 0);
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1;
  return readLineMetadata(start, lineCount);
}

/**
 * A Grep row's count re-derived from its text, for results that carry none: a
 * result persisted by a build that did not have Grep set its own (#311). Grep
 * itself counts from the data it collected, which is exact where this is not —
 * a context line's text can hold a `12:30` of its own, and a match spanning
 * lines is several lines. In the unit `output_mode` asks for: matches in
 * `content` and `count` mode, files in `files_with_matches`.
 */
export function grepResultMetadata(args: Record<string, unknown>, content: string): string {
  const noun = args.output_mode === 'files_with_matches' ? 'file' : 'match';
  if (/^No matches found$/i.test(content.trim()))
    return `0 ${noun === 'file' ? 'files' : 'matches'}`;
  const lines = content.split('\n');
  let count: number;
  if (noun === 'file') count = lines.filter((line) => line.trim()).length;
  else if (args.output_mode === 'count') {
    count = lines.reduce((total, line) => total + (Number(/:(\d+)\s*$/.exec(line)?.[1]) || 0), 0);
  } else count = lines.filter((line) => /:\d+:/.test(line)).length || nonEmptyLines(content);
  return `${count} ${count === 1 ? noun : noun === 'file' ? 'files' : 'matches'}`;
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
    const mutation = result.artifacts?.fileMutation ?? result.artifacts?.fileMutations?.[0];
    if (mutation) {
      if (inferMetadata) {
        if (mutation.addedLines) metadata.push(`+${mutation.addedLines}`);
        if (mutation.removedLines) metadata.push(`-${mutation.removedLines}`);
        if (!mutation.addedLines && !mutation.removedLines) metadata.push('no changes');
      }
      if (inferSummary) {
        summary = `${mutation.kind === 'create' ? 'Created' : mutation.kind === 'delete' ? 'Deleted' : 'Updated'} ${mutation.filePath}`;
      }
    }
  } else if (name === 'Read') {
    if (inferKind) kind = 'file';
    if (inferMetadata && result.status === 'success')
      metadata.push(...readResultMetadata(args, content));
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
    // Only a search that ran has matches to count; a failed one is a row with
    // the error, the way Read's is.
    if (result.status === 'success') {
      const label = grepResultMetadata(args, content);
      if (inferMetadata) metadata.push(label);
      if (inferSummary) summary = `Found ${label}`;
    }
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

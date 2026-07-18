import { existsSync, readFileSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import type { FileObservation } from '../types.js';
import { workspaceIdentity } from '../tools/file-provenance.js';
import { resolveWorkspaceMentionPath } from './file-mentions.js';

const AT_MENTION_CHAR_LIMIT = 20_000;

interface MentionToken {
  start: number;
  end: number;
  path: string;
  raw: string;
  trailing: string;
}

function isMentionBoundary(input: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s([{<"']/.test(input[index - 1]);
}

function splitTrailingPunctuation(token: string): { path: string; trailing: string } {
  let end = token.length;
  while (end > 0 && /[.,;:!?)]/.test(token[end - 1])) end--;
  return { path: token.slice(0, end), trailing: token.slice(end) };
}

function findMentionTokens(input: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  let i = 0;

  while (i < input.length) {
    if (input[i] !== '@' || !isMentionBoundary(input, i)) {
      i++;
      continue;
    }

    const start = i;
    const afterAt = i + 1;
    if (afterAt >= input.length || /\s/.test(input[afterAt])) {
      i++;
      continue;
    }

    if (input[afterAt] === '"') {
      const close = input.indexOf('"', afterAt + 1);
      if (close === -1) {
        i++;
        continue;
      }
      const filePath = input.slice(afterAt + 1, close);
      if (!filePath) {
        i = close + 1;
        continue;
      }
      tokens.push({
        start,
        end: close + 1,
        path: filePath,
        raw: input.slice(start, close + 1),
        trailing: '',
      });
      i = close + 1;
      continue;
    }

    let end = afterAt;
    while (end < input.length && !/\s/.test(input[end])) end++;
    const rawPath = input.slice(afterAt, end);
    const { path, trailing } = splitTrailingPunctuation(rawPath);
    if (path) {
      tokens.push({
        start,
        end: end - trailing.length,
        path,
        raw: input.slice(start, end - trailing.length),
        trailing,
      });
    }
    i = end;
  }

  return tokens;
}

function formatMentionError(filePath: string, reason: string): string {
  return `\n[Could not include @${filePath}: ${reason}]\n`;
}

function looksBinary(content: string): boolean {
  return content.includes('\0');
}

interface ExpandedMention {
  text: string;
  observation?: FileObservation;
}

export interface ExpandedAtMentions {
  text: string;
  fileObservations: FileObservation[];
}

function expandMention(filePath: string, workspace: string, sourceRef: string): ExpandedMention {
  const resolved = resolveWorkspaceMentionPath(workspace, filePath);
  if (!resolved) return { text: formatMentionError(filePath, 'path is outside the workspace') };
  if (!existsSync(resolved.filePath))
    return { text: formatMentionError(filePath, 'file not found') };

  try {
    const stat = statSync(resolved.filePath);
    if (stat.isDirectory())
      return { text: formatMentionError(resolved.relativePath, 'path is a directory') };
    if (!stat.isFile())
      return { text: formatMentionError(resolved.relativePath, 'path is not a regular file') };

    const content = readFileSync(resolved.filePath, 'utf-8');
    if (looksBinary(content))
      return { text: formatMentionError(resolved.relativePath, 'file appears to be binary') };

    const truncated = content.length > AT_MENTION_CHAR_LIMIT;
    const body = truncated ? content.slice(0, AT_MENTION_CHAR_LIMIT) : content;
    const suffix = truncated
      ? `\n\n[File truncated at ${AT_MENTION_CHAR_LIMIT} characters; use the Read tool for more.]`
      : '';
    const endByte = Buffer.byteLength(body, 'utf-8');
    const observation = createTextFileObservation({
      workspaceRoot: workspace,
      path: resolved.relativePath,
      content,
      coverage: truncated
        ? { kind: 'bytes', startByte: 0, endByte, totalBytes: Buffer.byteLength(content, 'utf-8') }
        : { kind: 'full' },
      operation: 'mention',
      sourceRef,
    });

    return {
      text: `\nContents of ${resolved.relativePath}:\n\n\`\`\`\n${body}${suffix}\n\`\`\`\n`,
      observation,
    };
  } catch (e: any) {
    return {
      text: formatMentionError(filePath, e?.message?.slice(0, 200) || 'unable to read file'),
    };
  }
}

/** Expand @path references and return their exact file observations. */
export function expandAtMentionsWithObservations(
  input: string,
  workspace: string,
  sourceRef = 'message://current/user-input',
): ExpandedAtMentions {
  const tokens = findMentionTokens(input);
  if (tokens.length === 0) return { text: input, fileObservations: [] };

  let output = '';
  let cursor = 0;
  const fileObservations: FileObservation[] = [];
  for (const token of tokens) {
    output += input.slice(cursor, token.start);
    const expanded = expandMention(token.path, workspace, sourceRef);
    output += expanded.text;
    if (expanded.observation) fileObservations.push(expanded.observation);
    output += token.trailing;
    cursor = token.end + token.trailing.length;
  }
  output += input.slice(cursor);
  return { text: output, fileObservations };
}

/** Backward-compatible convenience wrapper returning expanded text only. */
export function expandAtMentions(input: string, workspace: string): string {
  return expandAtMentionsWithObservations(input, workspace).text;
}

export function collectAtMentionObservations(
  input: string,
  workspace: string,
  sourceRef: string,
): FileObservation[] {
  const workspaceId = workspaceIdentity(workspace);
  const observations: FileObservation[] = [];
  for (const token of findMentionTokens(input)) {
    const resolved = resolveWorkspaceMentionPath(workspace, token.path);
    if (!resolved || !existsSync(resolved.filePath)) continue;
    try {
      const info = statSync(resolved.filePath);
      if (!info.isFile()) continue;
      const bytes = readFileSync(resolved.filePath);
      observations.push({
        path: resolved.relativePath,
        workspaceId,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteSize: bytes.byteLength,
        operation: 'mention',
        sourceRef,
        timestamp: Date.now(),
      });
    } catch {
      // Failed mentions are represented in expanded context, not provenance.
    }
  }
  return observations;
}

/**
 * Expand !cmd shell commands to their output in user input.
 * Replaces lines starting with !<cmd> with the command's stdout.
 */
export function expandShellCommands(input: string, workspace: string): string {
  return input.replace(/^!(\S.*)$/gm, (_match: string, cmd: string) => {
    try {
      const output = execSync(cmd, {
        cwd: workspace,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }).trim();
      return output || `(command '${cmd}' produced no output)`;
    } catch (e: any) {
      return `(command '${cmd}' failed: ${e.message?.slice(0, 200) || 'unknown error'})`;
    }
  });
}

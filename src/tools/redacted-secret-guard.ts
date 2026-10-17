import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import type { ToolContext, ToolResult } from '../types/tools.js';
import { toolFailure } from './result.js';

/**
 * Refuse a mutation that would put the redaction marker into a file that holds a provider key.
 *
 * The model only ever sees `[redacted: provider key]` where the key is (#411), so reading such a
 * file and writing it back replaces the real credential with the marker. Fires only when the file
 * on disk holds one of the session's secrets *and* the new text carries the marker: writing the
 * marker to a file with no key (Book's own docs and tests) is fine.
 */
export function redactedSecretOverwrite(
  ctx: ToolContext,
  shownPath: string,
  existing: string,
  incoming: readonly string[],
): ToolResult | undefined {
  const secrets = ctx.providerSecrets;
  if (!secrets?.length) return undefined;
  if (!incoming.some((text) => text.includes(PROVIDER_KEY_MARKER))) return undefined;
  if (!secrets.some((secret) => existing.includes(secret))) return undefined;
  return toolFailure(
    `${shownPath} holds a provider key, which Book shows as ${PROVIDER_KEY_MARKER}. Writing that marker back would replace the real key.`,
    {
      code: 'redacted_secret_overwrite',
      remediation:
        'Use Edit on only the lines that need to change, without the line that shows the marker, or ask the user to make the change.',
    },
  );
}

/**
 * Refuse deleting a file that holds a provider key (#519).
 *
 * Book never sees the real value, so it can never write it back: a delete is how a rewrite loses
 * the key (Delete File, then Add File with the marker), whether the two arrive in one patch or two.
 */
export function redactedSecretDeletion(
  ctx: ToolContext,
  shownPath: string,
  existing: string,
): ToolResult | undefined {
  const secrets = ctx.providerSecrets;
  if (!secrets?.length) return undefined;
  if (!secrets.some((secret) => existing.includes(secret))) return undefined;
  return toolFailure(
    `${shownPath} holds a provider key, which Book shows as ${PROVIDER_KEY_MARKER}. Deleting or rewriting the file would lose the real key, and Book cannot write it back.`,
    {
      code: 'redacted_secret_overwrite',
      remediation:
        'Edit only the lines that need to change, with Edit or an Update File hunk that leaves the key line alone, or ask the user to make the change.',
    },
  );
}

/**
 * Refuse a shell command whose text carries the redaction marker (#519).
 *
 * The marker stands for a provider key the model cannot see, so a command that names it can only
 * write the marker where the key was, or use it as though it were a credential. Matching the text
 * needs no secrets: the marker is a fixed string, and a command has no business containing it.
 */
export function redactedSecretCommand(command: string | undefined): ToolResult | undefined {
  if (!command?.includes(PROVIDER_KEY_MARKER)) return undefined;
  return toolFailure(
    `The command contains ${PROVIDER_KEY_MARKER}, which stands for a real provider key that the model cannot see. A command must not write or use it.`,
    {
      code: 'redacted_secret_command',
      remediation:
        'Edit the file with Edit on only the lines that need to change, or ask the user to make the change.',
    },
  );
}

/**
 * `book config provider-key <id>`: replace the API key of a provider in the user file (#592).
 *
 * The key is read from stdin, hidden on a terminal and piped otherwise, and never from the command
 * line, where it would land in shell history and the process table. Like every `config`
 * subcommand it runs without a working credential: replacing a dead key is the reason it exists.
 */
import { createInterface } from 'readline';
import { Writable } from 'stream';
import { exit } from './exit.js';
import {
  checkProviderKey,
  providerKeyTarget,
  validateApiKey,
  writeProviderKey,
  type ProviderKeyCheckOptions,
} from '../provider-key.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { settingsScopeLabel, type SettingsScope } from '../settings-scope.js';

/** stdin, or a stand-in for it in tests. */
export interface ProviderKeyInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface ProviderKeyCommandOptions {
  /** False for `--no-check`: save without asking the endpoint. */
  check?: boolean;
  /** `--force`: save even when the check fails. */
  force?: boolean;
  /** `-g` / `--project` / `--local`. Only the user layer holds providers this edits. */
  scope?: SettingsScope;
  /** `--settings <path>` or `--no-settings` was passed: refused, since neither changes the target. */
  ignoresSettingsFlags?: boolean;
  stdin?: ProviderKeyInput;
  /** Where prompts go; stdout stays for the result. */
  stderr?: NodeJS.WritableStream;
  discover?: ProviderKeyCheckOptions['discover'];
}

const USAGE = 'Usage: book config provider-key <provider-id>  (the key is read from stdin)';

/** Far above any real key; a stream past it is not one, and is not read to the end. */
const MAX_PIPED_BYTES = 64 * 1024;

/**
 * Read a piped stdin, dropping the one line ending `echo` adds. Undefined when the input runs past
 * {@link MAX_PIPED_BYTES}.
 */
async function readPiped(input: ProviderKeyInput): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_PIPED_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks)
    .toString('utf-8')
    .replace(/\r?\n$/, '');
}

/** One line from a terminal; undefined on Ctrl+C or Ctrl+D. `hidden` echoes nothing. */
async function readTerminalLine(
  input: ProviderKeyInput,
  stderr: NodeJS.WritableStream,
  prompt: string,
  hidden: boolean,
): Promise<string | undefined> {
  stderr.write(prompt);
  const output = hidden
    ? new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      })
    : stderr;
  const rl = createInterface({ input, output, terminal: true });
  try {
    return await new Promise<string | undefined>((resolve) => {
      rl.once('line', resolve);
      rl.once('SIGINT', () => resolve(undefined));
      rl.once('close', () => resolve(undefined));
    });
  } finally {
    rl.close();
    if (hidden) stderr.write('\n');
  }
}

type FailureChoice = 'save' | 'retry' | 'edit' | 'cancel';

async function askAfterFailure(
  input: ProviderKeyInput,
  stderr: NodeJS.WritableStream,
): Promise<FailureChoice> {
  const answer = await readTerminalLine(
    input,
    stderr,
    '[s] save anyway  [r] retry  [e] enter a different key  [c] cancel: ',
    false,
  );
  switch (answer?.trim().toLowerCase()) {
    case 's':
      return 'save';
    case 'r':
      return 'retry';
    case 'e':
      return 'edit';
    default:
      return 'cancel';
  }
}

export async function runProviderKeyCommand(
  workspace: string,
  providerId: string | undefined,
  extra: string | undefined,
  options: ProviderKeyCommandOptions = {},
): Promise<void> {
  const stdin = options.stdin ?? (process.stdin as ProviderKeyInput);
  const stderr = options.stderr ?? process.stderr;
  if (extra !== undefined) {
    // Never echoed: it is most likely the key itself.
    console.error(
      'provider-key reads the key from stdin, never from an argument; nothing was saved. ' +
        'A key typed on the command line is in your shell history: consider rotating it.',
    );
    console.error(USAGE);
    return exit(1);
  }
  if (!providerId) {
    console.error(USAGE);
    return exit(1);
  }
  if (options.ignoresSettingsFlags) {
    console.error(
      'provider-key edits your user settings (<BOOK_HOME>/settings.json) whatever the settings ' +
        'layers in use; --settings and --no-settings do not apply to it.',
    );
    return exit(1);
  }
  if (options.scope && options.scope !== 'user') {
    console.error(
      `provider-key changes providers in your user settings only, not ${settingsScopeLabel(options.scope)} settings.`,
    );
    return exit(1);
  }

  const target = providerKeyTarget(workspace, providerId);
  if (target.kind === 'unreadable') {
    console.error(`Could not read user settings (${target.path}): ${target.error}`);
    return exit(1);
  }
  if (target.kind === 'workspace-only') {
    console.error(
      `Provider "${providerId}" is declared by this repository (${target.declaredIn}), not your ` +
        `user settings (${target.path}). provider-key changes only providers you configured.`,
    );
    return exit(1);
  }
  if (target.kind === 'unknown') {
    console.error(
      // The id is not repeated: one that names no provider is as likely to be a key typed in
      // its place, and the command promises never to echo a key.
      `No provider with that id in user settings (${target.path}). ` +
        (target.configured.length > 0
          ? `Configured: ${target.configured.join(', ')}.`
          : 'No providers are configured there yet; add one with /providers in the TUI.'),
    );
    return exit(1);
  }

  const interactive = stdin.isTTY === true;
  const readKey = async (): Promise<string> => {
    const raw = interactive
      ? await readTerminalLine(stdin, stderr, `API key for ${providerId}: `, true)
      : await readPiped(stdin);
    if (raw === undefined) {
      console.error(
        interactive
          ? 'Cancelled; nothing was saved.'
          : `The input is longer than ${MAX_PIPED_BYTES} bytes, which no API key is; nothing was saved.`,
      );
      return exit(1);
    }
    try {
      return validateApiKey(raw);
    } catch (caught) {
      console.error(caught instanceof Error ? caught.message : 'Invalid API key.');
      return exit(1);
    }
  };

  let apiKey = await readKey();
  let tested = false;
  while (options.check !== false) {
    const result = await checkProviderKey({
      provider: target.provider,
      apiKey,
      workspace,
      retry: DEFAULT_SETTINGS.retry,
      discover: options.discover,
    });
    if (result.ok) {
      tested = true;
      break;
    }
    console.error(`The key check failed: ${result.error}`);
    if (options.force) {
      console.warn('Saving anyway (--force).');
      break;
    }
    if (!interactive) {
      console.error(
        'Nothing was saved. Pass --force to save anyway, or --no-check to skip the check.',
      );
      return exit(1);
    }
    const choice = await askAfterFailure(stdin, stderr);
    if (choice === 'save') break;
    if (choice === 'cancel') {
      console.error('Cancelled; nothing was saved.');
      return exit(1);
    }
    if (choice === 'edit') apiKey = await readKey();
  }

  const written = writeProviderKey(workspace, providerId, apiKey);
  if (!written.ok) {
    console.error(written.error);
    return exit(1);
  }
  console.log(
    `Updated the API key of provider "${providerId}" in user settings (${written.path})` +
      (tested ? '; the endpoint accepted it.' : '.'),
  );
  if (written.localCleared) {
    console.log(
      `Removed the connection keys of the same-named entry in ${written.localCleared}, which ` +
        'would otherwise look like they override it.',
    );
  }
  if (written.localError) {
    console.warn(`⚠  Could not clean up the local entry: ${written.localError}`);
  }
}

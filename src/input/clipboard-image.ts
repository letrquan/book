import { spawn } from 'child_process';

export const MAX_CLIPBOARD_IMAGE_BYTES = 8 * 1024 * 1024;

export interface ClipboardImage {
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

interface CommandResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

function run(command: string, args: string[], timeoutMs = 5_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CLIPBOARD_IMAGE_BYTES * 2) {
        child.kill();
        reject(new Error('Clipboard image exceeds the 8 MB limit.'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
    });
  });
}

export function detectImageMediaType(bytes: Uint8Array): ClipboardImage['mediaType'] | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const header = Buffer.from(bytes.subarray(0, 12)).toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function validated(bytes: Uint8Array): ClipboardImage {
  if (bytes.byteLength === 0) throw new Error('No image is available on the clipboard.');
  if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error('Clipboard image exceeds the 8 MB limit.');
  }
  const mediaType = detectImageMediaType(bytes);
  if (!mediaType)
    throw new Error('Clipboard image format is unsupported. Use PNG, JPEG, GIF, or WebP.');
  return { bytes, mediaType };
}

async function readWindowsClipboard(): Promise<ClipboardImage> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }',
    '$image = [System.Windows.Forms.Clipboard]::GetImage()',
    '$stream = New-Object System.IO.MemoryStream',
    '$image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)',
    '[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))',
  ].join('; ');
  let lastError: unknown;
  for (const command of ['pwsh.exe', 'powershell.exe']) {
    try {
      const result = await run(command, [
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-Command',
        script,
      ]);
      if (result.code === 3) throw new Error('No image is available on the clipboard.');
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'Clipboard helper failed.');
      return validated(Buffer.from(result.stdout.toString().trim(), 'base64'));
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /No image is available/.test(error.message)) throw error;
    }
  }
  throw new Error(
    `Unable to read the Windows clipboard${lastError instanceof Error ? `: ${lastError.message}` : '.'}`,
  );
}

async function readUnixClipboard(): Promise<ClipboardImage> {
  const candidates: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pngpaste', ['-']]]
      : [
          ['wl-paste', ['--no-newline', '--type', 'image/png']],
          ['wl-paste', ['--no-newline', '--type', 'image/jpeg']],
          ['wl-paste', ['--no-newline', '--type', 'image/webp']],
          ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
          ['xclip', ['-selection', 'clipboard', '-t', 'image/jpeg', '-o']],
          ['xclip', ['-selection', 'clipboard', '-t', 'image/webp', '-o']],
        ];
  let lastError: unknown;
  for (const [command, args] of candidates) {
    try {
      const result = await run(command, args);
      if (result.code === 0 && result.stdout.length > 0) return validated(result.stdout);
      lastError = new Error(result.stderr.trim() || `${command} found no clipboard image.`);
    } catch (error) {
      lastError = error;
    }
  }
  const installHint =
    process.platform === 'darwin' ? 'Install pngpaste' : 'Install wl-paste or xclip';
  throw new Error(
    `${installHint} to paste images${lastError instanceof Error ? `: ${lastError.message}` : '.'}`,
  );
}

export async function readClipboardImage(): Promise<ClipboardImage> {
  return process.platform === 'win32' ? readWindowsClipboard() : readUnixClipboard();
}
